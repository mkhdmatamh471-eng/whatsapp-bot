import express from 'express';
import sqlite3 from 'sqlite3';
import { createServer } from 'http';
import { Server } from 'socket.io';
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// معالجة الأخطاء العامة لمنع السيرفر من التوقف نهائياً
process.on('uncaughtException', (err) => {
    console.error('⚠️ خطأ غير متوقع (تم تداركه):', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ رفض وعد غير معالج (تم تداركه):', reason?.message || reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let sock = null;
let isAiActive = true;

// نظام الذاكرة للمحادثات
const userSessions = new Map();
const MAX_HISTORY = 15;

// نظام قاعدة بيانات العملاء المحتملين
const leadsFile = path.join(__dirname, 'leads.json');
let leads = [];
if (fs.existsSync(leadsFile)) {
    try { leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8')); } catch (e) { leads = []; }
}

// تهيئة قاعدة بيانات SQLite المحلية للعقارات
const dbFile = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error('Database opening error: ' + err.message);
    else console.log('📦 تم الاتصال بقاعدة بيانات SQLite بنجاح.');
});

// إنشاء جدول العقارات
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS estates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        type TEXT,
        price TEXT,
        location TEXT,
        status TEXT,
        mediaUrl TEXT,
        description TEXT
    )`);
});

// مسارات إدارة العقارات
app.get('/api/estates', (req, res) => {
    db.all("SELECT * FROM estates", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/estates', (req, res) => {
    const { title, type, price, location, status, mediaUrl, description } = req.body;
    const query = `INSERT INTO estates (title, type, price, location, status, mediaUrl, description) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.run(query, [title, type, price, location, status || 'متاح', mediaUrl, description], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
    });
});

app.delete('/api/estates/:id', (req, res) => {
    db.run(`DELETE FROM estates WHERE id = ?`, req.params.id, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// إعدادات الذكاء الاصطناعي
let aiConfig = {
    apiKey: '',
    systemInstruction: `أنت مستشار عقاري آلي يعمل في المملكة العربية السعودية.
مهامك:
1. الترحيب بالعميل بأسلوب سعودي مهني وودود، وسؤاله إن كان يبحث عن عقار (شراء/إيجار) أم يرغب بعرض عقار.
2. جمع تفاصيل الطلب: (المدينة، الحي المفضل، نوع العقار: شقة/فيلا/أرض، الميزانية، عدد الغرف).
3. طرح العروض: مطابقة طلب العميل مع قائمة العقارات المتاحة وإعطاؤه تفاصيل مبدئية مع ذكر رابط الوسائط إن وجد.
4. التنويه بأن توثيق العقود يتم عبر منصة "إيجار" أو "بورصة العقارات".
5. أخذ بيانات العميل الجاد (الاسم ورقم الجوال) وإبلاغه أن الوسيط العقاري سيتواصل معه.`
};

app.post('/api/ai-config', (req, res) => {
    const { systemInstruction } = req.body;
    if (systemInstruction !== undefined) aiConfig.systemInstruction = systemInstruction;
    res.json({ success: true, message: 'تم حفظ أوامر البوت بنجاح!' });
});

app.post('/api/toggle-ai', (req, res) => {
    const { active } = req.body;
    isAiActive = typeof active === 'boolean' ? active : !isAiActive;
    io.emit('ai-status', { active: isAiActive });
    res.json({ 
        success: true, 
        active: isAiActive, 
        message: isAiActive ? 'تم تفعيل ردود البوت' : 'تم تعطيل ردود البوت' 
    });
});

// جلب قائمة العملاء المحتملين
app.get('/api/leads', (req, res) => {
    res.json(leads);
});

// واجهة محاكي الدردشة مع مسح الذاكرة
app.post('/api/test-chat', async (req, res) => {
    const { message, reset } = req.body;
    const sessionId = 'web-tester';

    if (reset) {
        userSessions.delete(sessionId);
        return res.json({ reply: 'تم مسح ذاكرة المحادثة. البوت الآن لا يتذكر ما سبق.' });
    }

    if (!message) return res.status(400).json({ error: 'الرسالة مطلوبة' });
    if (!isAiActive) return res.json({ reply: 'البوت معطل حالياً من الإعدادات.' });

    const aiReply = await generateAIResponse(sessionId, message, null, null);
    res.json({ reply: aiReply });
});

app.post('/api/reset-session', (req, res) => {
    try {
        if (sock) {
            try { sock.end(); } catch (e) {}
            sock = null;
        }
        const authPath = path.join(__dirname, 'auth_info');
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }
        res.json({ success: true, message: 'تم إعادة ضبط الجلسة بنجاح.' });
    } catch (err) {
        res.status(500).json({ error: 'حدث خطأ أثناء مسح الجلسة' });
    }
});

async function generateAIResponse(userId, userMessage, socketClient = null, senderJid = null) {
    if (!aiConfig.apiKey) return "النظام متوقف حالياً، يرجى مراجعة الإدارة.";

    if (!userSessions.has(userId)) {
        userSessions.set(userId, []);
    }
    const history = userSessions.get(userId);
    history.push({ role: "user", content: userMessage });

    if (history.length > MAX_HISTORY) {
        history.splice(0, history.length - MAX_HISTORY);
    }

    return new Promise((resolve) => {
        db.all("SELECT * FROM estates", [], async (err, estates) => {
            const listingsText = estates.length > 0 
                ? estates.map(e => `- [ID: ${e.id}] ${e.title} (${e.type}) - السعر: ${e.price} - الموقع: ${e.location} - الحالة: ${e.status} - رابط الوسائط: ${e.mediaUrl || 'لا يوجد'} - التفاصيل: ${e.description}`).join('\n') 
                : "لا توجد عقارات مسجلة في النظام حالياً.";

            const systemPromptText = `العقارات المتاحة في قاعدة البيانات:
${listingsText}

التعليمات الأساسية:
${aiConfig.systemInstruction}

[تعليمات خاصة بالوسائط والبيانات]:
1. إذا طلب العميل صور أو ملف PDF لعقار معين، قم بتضمين هذا الوسم في نهاية ردك بدقة: [MEDIA_URL] رابط_الوسائط [/MEDIA_URL]
2. عندما يخبرك العميل بطلبه كاملاً وتحصل منه على (الاسم، ورقم الجوال، ونوع الطلب، والميزانية)، أضف هذا الوسم في النهاية:
[LEAD_JSON] {"name": "اسم العميل", "phone": "رقم الجوال", "request": "نوع الطلب", "budget": "الميزانية"} [/LEAD_JSON]`;

            try {
                const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${aiConfig.apiKey}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        model: "llama-3.3-70b-versatile",
                        messages: [
                            { role: "system", content: systemPromptText },
                            ...history
                        ],
                        temperature: 0.7,
                        max_tokens: 1024
                    })
                });

                const data = await response.json();
                if (data.error) throw new Error(data.error.message || "خطأ من سيرفر Groq");

                let botReply = data.choices?.[0]?.message?.content || "عذراً، لم أستطع فهم الطلب بشكل صحيح.";
                
                // استخراج رابط الوسائط للإرسال عبر واتساب
                const mediaRegex = /\[MEDIA_URL\]([\s\S]*?)\[\/MEDIA_URL\]/;
                const mediaMatch = botReply.match(mediaRegex);
                let mediaUrlToSend = null;

                if (mediaMatch) {
                    mediaUrlToSend = mediaMatch[1].trim();
                    botReply = botReply.replace(mediaRegex, '').trim();
                }

                // التقاط العملاء المحتملين
                const leadRegex = /\[LEAD_JSON\]([\s\S]*?)\[\/LEAD_JSON\]/;
                const match = botReply.match(leadRegex);
                
                if (match) {
                    try {
                        const leadData = JSON.parse(match[1].trim());
                        leadData.timestamp = new Date().toLocaleString('ar-SA');
                        leads.unshift(leadData);
                        fs.writeFileSync(leadsFile, JSON.stringify(leads, null, 2));
                        
                        botReply = botReply.replace(leadRegex, '').trim();
                        io.emit('new-lead', leadData);
                    } catch (e) {
                        console.error('Lead Parse Error:', e);
                    }
                }

                history.push({ role: "assistant", content: botReply });

                // إرسال الصور أو ملفات الـ PDF عبر الواتساب تلقائياً إن وجدت
                if (socketClient && senderJid && mediaUrlToSend && mediaUrlToSend !== 'لا يوجد') {
                    try {
                        if (mediaUrlToSend.endsWith('.pdf')) {
                            await socketClient.sendMessage(senderJid, { document: { url: mediaUrlToSend }, mimetype: 'application/pdf', fileName: 'Brochure.pdf', caption: 'ملف تفاصيل العقار' });
                        } else {
                            await socketClient.sendMessage(senderJid, { image: { url: mediaUrlToSend }, caption: 'صورة العقار المطلوب' });
                        }
                    } catch (mediaErr) {
                        console.error('⚠️ تعذر إرسال الوسائط:', mediaErr.message);
                    }
                }

                resolve(botReply);
            } catch (error) {
                console.error('[GROQ REST API ERROR]', error);
                history.pop();
                resolve("عذراً، أواجه ضغطاً حالياً. يرجى ترك رسالتك وسيتواصل معك الوسيط العقاري.");
            }
        });
    });
}

async function connectToWhatsApp(phoneNumber, socket) {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(phoneNumber, socket), 1500);
            } else {
                if(socket) socket.emit('status', { connected: false, message: 'تم تسجيل الخروج.' });
            }
        } else if (connection === 'open') {
            if(socket) socket.emit('status', { connected: true, message: '✅ البوت العقاري مرتبط ومستعد!' });
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            try {
                if (msg.key.fromMe || !msg.message) continue;
                const senderJid = msg.key.remoteJid;
                const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
                if (!textMessage) continue;
                
                console.log(`📩 [${senderJid}]: ${textMessage}`);

                if (!isAiActive) continue;

                const aiReply = await generateAIResponse(senderJid, textMessage, sock, senderJid);
                
                // حماية إرسال الرسالة لتفادي الانهيار عند انقطاع الاتصال
                try {
                    await sock.sendMessage(senderJid, { text: aiReply });
                } catch (sendErr) {
                    console.error('⚠️ تعذر إرسال رد الواتساب (انقطاع مؤقت):', sendErr.message);
                }
            } catch (err) {
                console.error('⚠️ خطأ أثناء معالجة الرسالة الواردة:', err.message);
            }
        }
    });

    if (!sock.authState.creds.registered && phoneNumber) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                if(socket) socket.emit('pairing-code', { code });
            } catch (err) {}
        }, 3000);
    }
}

io.on('connection', (socket) => {
    socket.emit('ai-status', { active: isAiActive });
    socket.on('request-pairing-code', async (phoneNumber) => {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        await connectToWhatsApp(cleanNumber, socket);
    });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`🚀 النظام يعمل على: http://localhost:3000`));

