// index.js (Node.js server)

require('dotenv').config(); // Đảm bảo dotenv được nạp trước khi sử dụng bất kỳ biến môi trường nào

const admin = require('firebase-admin');
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// --- Cấu hình Firebase Admin SDK ---
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://smartkey-3faeb-default-rtdb.firebaseio.com'
});

const db = admin.database();

let currentAwayMode = false;
// lastNotifiedLogTimestamp sẽ lưu trữ timestamp (mili giây) của log cuối cùng đã được xử lý và thông báo.
// Ban đầu sẽ là 0, sau đó được tải từ DB.
let lastNotifiedLogTimestamp = 0;

console.log('Server started, initializing...');

// --- Hàm khởi tạo server và tải trạng thái từ DB ---
async function initializeServer() {
  try {
    // 1. Tải lastNotifiedLogTimestamp từ database
    const configSnapshot = await db.ref('serverConfig/lastNotifiedLogTimestamp').get();
    if (configSnapshot.exists()) {
      lastNotifiedLogTimestamp = configSnapshot.val();
      console.log(`Loaded lastNotifiedLogTimestamp from DB: ${lastNotifiedLogTimestamp}`);
    } else {
      console.log('No previous lastNotifiedLogTimestamp found in DB. Starting from 0.');
      // Khởi tạo 0 vào DB nếu chưa có để đảm bảo node tồn tại
      await db.ref('serverConfig/lastNotifiedLogTimestamp').set(0);
    }

    // 2. Lắng nghe thay đổi của awayMode
    db.ref('awayMode').on('value', (snapshot) => {
      currentAwayMode = snapshot.val();
      console.log(`Away Mode changed to: ${currentAwayMode}`);
    });

    // 3. Lắng nghe thay đổi của logs (Đã thay đổi logic lắng nghe)
    // Sẽ lắng nghe tất cả các log mới hơn lastNotifiedLogTimestamp (đã đổi sang giây để khớp với log.timestamp)
    db.ref('logs')
      .orderByChild('timestamp') // Sắp xếp theo timestamp (giây)
      .startAt(lastNotifiedLogTimestamp > 0 ? (lastNotifiedLogTimestamp / 1000) + 1 : 0) // Bắt đầu từ log mới hơn 1 giây so với log cuối đã thông báo (nếu có)
      .on('child_added', async (snapshot) => {
        const log = snapshot.val();
        const logId = snapshot.key;

        console.log(`New log added: ${logId}`, log);

        // Chuyển timestamp của log sang mili giây để so sánh với lastNotifiedLogTimestamp (đang là mili giây)
        const logTimestampMs = log.timestamp * 1000;

        // Kiểm tra nếu chế độ vắng nhà đang bật VÀ đây là truy cập thất bại
        // VÀ log này mới hơn log cuối cùng đã thông báo
        if (currentAwayMode && !log.success && logTimestampMs > lastNotifiedLogTimestamp) {
          console.log('Unauthorized access detected with Away Mode ON. Attempting to send notification and save history...');
          const success = await sendNotification(log); // Gửi thông báo và lưu lịch sử
          if (success) {
            // Chỉ cập nhật lastNotifiedLogTimestamp vào DB nếu gửi thông báo và lưu lịch sử thành công
            lastNotifiedLogTimestamp = logTimestampMs;
            await db.ref('serverConfig/lastNotifiedLogTimestamp').set(lastNotifiedLogTimestamp);
            console.log(`Updated lastNotifiedLogTimestamp in DB to: ${lastNotifiedLogTimestamp}`);
          } else {
            console.error('Failed to send notification or save history for log:', logId);
          }
        }
      });

    // Khởi động server Express
    app.get('/', (req, res) => {
      res.send('Smart Lock Notifier is running and listening for events.');
    });

    app.listen(port, () => {
      console.log(`Smart Lock Notifier listening on port ${port}`);
    });

  } catch (error) {
    console.error('Failed to initialize server:', error);
    process.exit(1); // Thoát ứng dụng nếu không thể khởi tạo
  }
}

// --- Hàm gửi thông báo FCM và LƯU LỊCH SỬ THÔNG BÁO ---
async function sendNotification(accessLog) {
  const notificationTimestamp = Date.now(); // Thời gian tạo thông báo (mili giây)

  const notificationData = {
    title: 'Cảnh báo an ninh!',
    body: `Phát hiện truy cập trái phép bằng ${accessLog.method} khi chế độ vắng nhà đang bật.`,
    method: accessLog.method,
    success: accessLog.success,
    logTimestamp: accessLog.timestamp * 1000, // Chuyển log timestamp sang mili giây để lưu
    notificationTimestamp: notificationTimestamp, // Timestamp của thông báo (mili giây)
  };

  let dbSaveSuccess = false;
  // 1. Lưu thông báo vào lịch sử trong Firebase Database
  try {
    const newNotificationRef = await db.ref('notificationHistory').push(notificationData);
    console.log(`Notification saved to DB with ID: ${newNotificationRef.key}`);
    dbSaveSuccess = true;
  } catch (dbError) {
    console.error('Lỗi khi lưu thông báo vào database:', dbError);
    return false; // Nếu lưu DB thất bại, dừng lại
  }

  // 2. Gửi thông báo FCM (chỉ gửi nếu lưu DB thành công)
  if (dbSaveSuccess) {
    const message = {
      notification: {
        title: notificationData.title,
        body: notificationData.body,
      },
      data: {
        logId: accessLog.id || 'N/A', // Có thể log.id không tồn tại, cần đảm bảo
        method: String(accessLog.method),
        success: String(accessLog.success),
        timestamp: String(accessLog.timestamp), // Gửi log timestamp (giây)
        notificationTimestamp: String(notificationData.notificationTimestamp), // Gửi notification timestamp (mili giây)
        notificationType: 'unauthorized_access',
      },
      topic: 'unauthorized_access_alerts',
    };

    try {
      const response = await admin.messaging().send(message);
      console.log('Successfully sent message:', response);
      return true; // Trả về true nếu cả lưu DB và gửi FCM thành công
    } catch (error) {
      console.error('Error sending message:', error);
      return false; // Trả về false nếu gửi FCM thất bại
    }
  }
  return false; // Nếu không lưu DB thành công thì cũng không gửi FCM và trả về false
}

// Gọi hàm khởi tạo server
initializeServer();