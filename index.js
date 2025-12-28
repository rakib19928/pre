require('dotenv').config();
const admin = require('firebase-admin');
const axios = require('axios');
const express = require('express');
const cron = require('node-cron'); 

// কনফিগারেশন
const USDT_RATE = 125.56; 

// ১. রেলওয়ে হেলথ চেক সার্ভার (সংশোধিত)
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
    res.status(200).send('Bot Status: Active');
});

// ০.০.০.০ ব্যবহার করা হয়েছে যাতে রেলওয়ে কানেকশন পায়
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Health Check Server listening on port ${PORT}`);
});


// ২. এনভায়রনমেন্ট ভেরিয়েবল লোড
if (!process.env.FIREBASE_SERVICE) throw new Error("Missing FIREBASE_SERVICE env variable");
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE);

if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN env variable");
const BOT_TOKEN = process.env.BOT_TOKEN;

// ৩. Firebase initialize
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// নম্বর ফরম্যাটিং ফাংশন
function formatMoney(amount) {
    return Number(amount).toFixed(2)
        .replace('.', ',')
        .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// তারিখ ফরম্যাটিং
function formatDate(date) {
    const d = new Date(date);
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

// বর্তমান সপ্তাহের রেঞ্জ বের করা (শনিবার থেকে শুক্রবার)
function getWeekRange() {
    const now = new Date();
    const dayOfWeek = now.getDay(); 
    const diffToSaturday = (dayOfWeek + 1) % 7; 
    
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - diffToSaturday);
    startOfWeek.setHours(0, 0, 0, 0);

    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);

    return { start: startOfWeek, end: endOfWeek };
}

// ৪. টোটাল এবং রেঞ্জ হিসাব করার ফাংশন
async function getStats(method, customStart = null, customEnd = null) {
    let start, end;

    if (customStart && customEnd) {
        start = customStart;
        end = customEnd;
    } else {
        const range = getWeekRange();
        start = range.start;
        end = range.end;
    }
    
    let stats = {
        weeklyDeposit: 0, 
        weeklyWithdraw: 0
    };

    try {
        // Deposit Query
        const depositSnap = await db.collection('depositRequests')
            .where('method', '==', method)
            .where('status', '==', 'approved')
            .get();
        
        depositSnap.forEach(doc => {
            const data = doc.data();
            const amount = Number(data.amount || 0);
            const time = data.createdAt && data.createdAt.seconds ? new Date(data.createdAt.seconds * 1000) : new Date();
            
            if (time >= start && time <= end) {
                stats.weeklyDeposit += amount;
            }
        });

        // Withdraw Query
        const withdrawSnap = await db.collection('withdrawRequests')
            .where('method', '==', method)
            .where('status', '==', 'approved')
            .get();

        withdrawSnap.forEach(doc => {
            const data = doc.data();
            const amount = Number(data.amount || 0);
            const time = data.createdAt && data.createdAt.seconds ? new Date(data.createdAt.seconds * 1000) : new Date();

            if (time >= start && time <= end) {
                stats.weeklyWithdraw += amount;
            }
        });

        return stats;
    } catch (err) {
        console.error("Error calculating stats:", err);
        return stats;
    }
}

// ৫. টেলিগ্রাম মেসেজ ফাংশন
async function sendTelegramMessage(groupId, message) {
  try {
    const res = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: groupId, 
      text: message,
      parse_mode: 'HTML'
    });
    return res.data.ok;
  } catch (err) {
    console.error('❌ Telegram error:', err.response?.data || err.message);
    return false;
  }
}

// ৮. ডেইলি শিডিউল টাস্ক
cron.schedule('25 2 * * *', async () => {
    console.log('⏰ Running daily report job at 12:00 PM...');
    try {
        const managersSnap = await db.collection('musers').get();
        if (managersSnap.empty) return;

        const end = new Date(); 
        end.setHours(23, 59, 59, 999); 

        const start = new Date();
        start.setDate(start.getDate() - 6); 
        start.setHours(0, 0, 0, 0); 

        for (const doc of managersSnap.docs) {
            const manager = doc.data();
            const method = manager.payment;
            const groupId = manager.groupId; 

            if (method && groupId) {
                // ডেইলি রিপোর্টেও ব্যালেন্স সরাসরি musers থেকে নেওয়া হচ্ছে
                const currentBalance = Number(manager.balance || 0);

                const stats = await getStats(method, start, end);

                const balanceFullBDT = currentBalance;
                const balanceFullUSDT = balanceFullBDT / USDT_RATE;
                
                const weeklyDepUSDT = stats.weeklyDeposit / USDT_RATE;
                const weeklyWdUSDT = stats.weeklyWithdraw / USDT_RATE;

                let msg = `t+→$ (Daily Report)\n`;
                msg += `<b>${method}</b>\n`;
                msg += `${formatDate(start)} - ${formatDate(end)} (Last 7 Days)\n`;
                
                msg += `Payment (7d) = ${formatMoney(stats.weeklyDeposit)} BDT (${formatMoney(weeklyDepUSDT)} USDT)\n`;
                
                msg += `Withdrawal (7d) = ${formatMoney(stats.weeklyWithdraw)} BDT (${formatMoney(weeklyWdUSDT)} USDT)\n`;
                
                msg += `Balance (full) = ${formatMoney(balanceFullBDT)} BDT (${formatMoney(balanceFullUSDT)} USDT)\n`;
                
                msg += `\n<i>🤖 Auto Generated Daily Report</i>`;

                await sendTelegramMessage(groupId, msg);
                console.log(`✅ Daily report sent to ${method}`);
            }
        }
    } catch (error) {
        console.error('❌ Daily Cron Job Error:', error);
    }
}, {
    scheduled: true,
    timezone: "Asia/Dhaka" 
});
// প্রসেস বন্ধ করার সিগন্যাল পেলে ক্রন জব স্টপ করা
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server and cron jobs');
  app.close(() => {
    process.exit(0);
  });
});


console.log('🚀 Bot is running with Daily Scheduler ONLY...');
