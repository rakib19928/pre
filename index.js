require('dotenv').config();
const admin = require('firebase-admin');
const axios = require('axios');
const express = require('express');
const cron = require('node-cron'); 

// === কনফিগারেশন ===
const USDT_RATE = 125.56; 
const PORT = process.env.PORT || 8080;

// === ১. সার্ভার সেটআপ (রেলওয়ে হেলথ চেক) ===
const app = express();

app.get('/', (req, res) => {
    res.status(200).send('Bot Status: Active (Dual Schedule)');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server listening on port ${PORT}`);
});

// === ২. এনভায়রনমেন্ট ভেরিয়েবল এবং ফায়ারবেস ===
if (!process.env.FIREBASE_SERVICE) throw new Error("Missing FIREBASE_SERVICE env variable");
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE);

if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN env variable");
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// === ৩. হেল্পার ফাংশনসমূহ ===

// নম্বর ফরম্যাটিং
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

// টেলিগ্রাম মেসেজ ফাংশন
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

// স্ট্যাটস ক্যালকুলেশন (শুধুমাত্র ১ম কাজের জন্য প্রয়োজন)
async function getStats(method, start, end) {
    let stats = {
        weeklyDeposit: 0, 
        weeklyWithdraw: 0
    };

    try {
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


// === ৪. শিডিউল টাস্ক ১: দুপুর ১২:০০ টা (Daily Report) ===
cron.schedule('0 12 * * *', async () => {
    console.log('⏰ Running Task 1: Daily full report (12:00 PM)...');
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
                
                // এখানে আগে থেকেই মাইনাস ছিল
                msg += `Balance (full) = -${formatMoney(balanceFullBDT)} BDT (-${formatMoney(balanceFullUSDT)} USDT)\n`;

                await sendTelegramMessage(groupId, msg);
                console.log(`✅ Task 1: Report sent to ${method}`);
            }
        }
    } catch (error) {
        console.error('❌ Task 1 Error:', error);
    }
}, {
    scheduled: true,
    timezone: "Asia/Dhaka" 
});


// === ৫. শিডিউল টাস্ক ২: রাত ৮:০০ টা (Balance Report) ===
cron.schedule('0 20 * * *', async () => {
    console.log('⏰ Running Task 2: Balance check (8:00 PM)...');
    try {
        const managersSnap = await db.collection('musers').get();
        if (managersSnap.empty) return;

        for (const doc of managersSnap.docs) {
            const manager = doc.data();
            const method = manager.payment;
            const groupId = manager.groupId; 

            if (method && groupId) {
                const currentBalance = Number(manager.balance || 0);

                const balanceFullBDT = currentBalance;
                const balanceFullUSDT = balanceFullBDT / USDT_RATE;
                
                let msg = `t+→p\n`;
                msg += `${method}\n`; 
                
                // [CHANGED] এখানে মাইনাস (-) চিহ্ন যোগ করা হয়েছে
                msg += `Balance (full) = -${formatMoney(balanceFullBDT)} BDT (-${formatMoney(balanceFullUSDT)} USDT)`;

                await sendTelegramMessage(groupId, msg);
                console.log(`✅ Task 2: Balance report sent to ${method}`);
            }
        }
    } catch (error) {
        console.error('❌ Task 2 Error:', error);
    }
}, {
    scheduled: true,
    timezone: "Asia/Dhaka" 
});

console.log('🚀 Bot is running with DUAL SCHEDULER (12:00 PM & 08:00 PM)...');
