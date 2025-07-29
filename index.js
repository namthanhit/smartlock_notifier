
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
let lastNotifiedLogTimestamp = 0; // Giá trị khởi tạo, sẽ được load từ DB

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
      // Có thể lưu 0 vào DB ngay nếu muốn đảm bảo node tồn tại
      await db.ref('serverConfig/lastNotifiedLogTimestamp').set(0);
    }

    // 2. Lắng nghe thay đổi của awayMode
    db.ref('awayMode').on('value', (snapshot) => {
      currentAwayMode = snapshot.val();
      console.log(`Away Mode changed to: ${currentAwayMode}`);
    });

    // 3. Lắng nghe thay đổi của logs (có thay đổi logic kiểm tra và cập nhật)
    db.ref('logs').orderByChild('timestamp').limitToLast(1).on('child_added', async (snapshot) => {
      const log = snapshot.val();
      const logId = snapshot.key;

      console.log(`New log added: ${logId}`, log);

      const logTimestampMs = log.timestamp * 1000;

      // Kiểm tra nếu chế độ vắng nhà đang bật VÀ đây là truy cập thất bại
      // VÀ log này mới hơn log cuối cùng đã thông báo
      if (currentAwayMode && !log.success && logTimestampMs > lastNotifiedLogTimestamp) {
        console.log('Unauthorized access detected with Away Mode ON. Sending notification...');
        const success = await sendNotification(log); // Gửi thông báo
        if (success) {
          // Chỉ cập nhật timestamp vào DB nếu gửi thông báo thành công
          lastNotifiedLogTimestamp = logTimestampMs;
          await db.ref('serverConfig/lastNotifiedLogTimestamp').set(lastNotifiedLogTimestamp);
          console.log(`Updated lastNotifiedLogTimestamp in DB to: ${lastNotifiedLogTimestamp}`);
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

// --- Hàm gửi thông báo FCM (giữ nguyên, chỉ thay đổi trả về boolean) ---
async function sendNotification(accessLog) {
  const message = {
    notification: {
      title: 'Cảnh báo an ninh!',
      body: `Phát hiện truy cập trái phép bằng ${accessLog.method} khi chế độ vắng nhà đang bật.`,
    },
    data: {
      logId: accessLog.id || 'N/A',
      method: accessLog.method,
      success: String(accessLog.success),
      timestamp: String(accessLog.timestamp),
      notificationType: 'unauthorized_access',
    },
    topic: 'unauthorized_access_alerts',
  };

  try {
    const response = await admin.messaging().send(message);
    console.log('Successfully sent message:', response);
    return true; // Trả về true nếu thành công
  } catch (error) {
    console.error('Error sending message:', error);
    return false; // Trả về false nếu thất bại
  }
}

// Gọi hàm khởi tạo server
initializeServer();