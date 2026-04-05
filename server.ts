import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import { createServer as createViteServer } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// ── AI SETUP ──────────────────────────────────────────────────
let genAI: any = null;
function getGenAI() {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is required");
    genAI = new GoogleGenAI({ apiKey });
  }
  return genAI;
}

const SYSTEM_PROMPTS = {
  CHAT_PATIENT: (patient: any, reminders: any) => `You are CogniCare AI, a warm, gentle, and patient companion for ${patient?.name || 'a person'} who has cognitive decline.
Your tone is exceptionally patient, reassuring, and clear.
- Use SIMPLE, SHORT sentences. Never use complex words or abstract metaphors.
- If they seem confused, gently orient them (e.g., "It's a beautiful Tuesday morning here in your living room").
- Remind them of upcoming activities if relevant: ${reminders.map((r: any) => `${r.time} - ${r.label}`).join(', ') || 'No reminders scheduled yet'}.
- If they mention pain, distress, or a fall, tell them to press the big red "HELP" button or call their caregiver immediately.
- Never argue or correct harshly — redirect gently.
- Use their first name often. Keep responses under 3 sentences.`,

  CHAT_CAREGIVER: (patient: any) => `You are an expert AI assistant for caregivers managing cognitive decline patients.
You help with:
- Interpreting behavioral changes and what they might mean.
- Suggesting care strategies and communication techniques (e.g., validation therapy).
- Explaining medication effects (always recommend consulting a doctor).
- Providing emotional support for caregiver burnout.
- Recommending activities for cognitive stimulation.
Patient context: ${patient ? `${patient.name}, Age: ${patient.age}, Stage: ${patient.stage}. Notes: ${patient.notes}` : 'Not specified'}.
Always be evidence-based, compassionate, and remind caregivers to consult medical professionals for medical decisions.`,
  
  ANALYZE: (name: string, context: string) => `Analyze this image/these frames of ${name} and provide a structured JSON response.
Identify behavioral indicators (agitation, confusion, wandering, calm) and physical safety risks (fall hazards, improper posture).
Return ONLY valid JSON with these fields:
{
  "observations": [list of specific behavioral or physical observations],
  "cognitiveIndicators": { "confusion": "none|mild|moderate|severe", "agitation": "none|mild|moderate|severe" },
  "physicalIndicators": { "posture": "description", "mobility": "description" },
  "urgency": "routine|attention|urgent",
  "summary": "A warm, human-readable paragraph summarizing the analysis",
  "safetyFlags": [any safety concerns]
}
${context ? `Context: ${context}` : ''}`,

  SUMMARY: (patient: any, logs: any) => `You are a Senior Geriatric Care Auditor. Analyze the following daily activity log for ${patient.name}.
Provide a concise, professional summary of the patient's day. 
Highlight:
1. Behavioral patterns (e.g., increased agitation in the evening).
2. Compliance with reminders.
3. Positive milestones or social interactions.
4. Specific concerns for the caregiver to watch for tomorrow.
Keep it under 200 words.
Activity Logs: ${JSON.stringify(logs)}`
};

// ── DATA LAYER ────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── DB helpers ────────────────────────────────────────────────
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) { console.warn('DB read error, using defaults'); }
  return {
    patients: [
      {
        id: 'P001', name: 'Margaret Thompson', age: 78, stage: 'Moderate',
        caregiver: 'Susan Thompson', phone: '(416) 555-0123',
        notes: 'Former schoolteacher. Enjoys classical music and gardening. Has trouble remembering recent events but long-term memory intact.',
        createdAt: new Date().toISOString()
      }
    ],
    reminders: [
      { id: 'R001', patientId: 'P001', type: 'meal', label: 'Breakfast', time: '08:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], active: true, createdAt: new Date().toISOString() },
      { id: 'R002', patientId: 'P001', type: 'medication', label: 'Morning medication', time: '09:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], active: true, createdAt: new Date().toISOString() },
      { id: 'R003', patientId: 'P001', type: 'meal', label: 'Lunch', time: '12:30', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], active: true, createdAt: new Date().toISOString() },
      { id: 'R004', patientId: 'P001', type: 'bathroom', label: 'Bathroom break', time: '14:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], active: true, createdAt: new Date().toISOString() },
      { id: 'R005', patientId: 'P001', type: 'medication', label: 'Afternoon medication', time: '15:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], active: true, createdAt: new Date().toISOString() },
      { id: 'R006', patientId: 'P001', type: 'meal', label: 'Dinner', time: '18:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], active: true, createdAt: new Date().toISOString() },
      { id: 'R007', patientId: 'P001', type: 'hydration', label: 'Drink water', time: '10:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], active: true, createdAt: new Date().toISOString() },
      { id: 'R008', patientId: 'P001', type: 'activity', label: 'Short walk outside', time: '11:00', days: ['Mon', 'Wed', 'Fri'], active: true, createdAt: new Date().toISOString() },
    ],
    activity: [
      { id: 'A001', patientId: 'P001', type: 'reminder_sent', message: 'Breakfast reminder sent', timestamp: new Date(Date.now() - 3600000 * 2).toISOString() },
      { id: 'A002', patientId: 'P001', type: 'analysis', message: 'Image analysis completed — no concerning signs observed', timestamp: new Date(Date.now() - 3600000 * 5).toISOString() },
      { id: 'A003', patientId: 'P001', type: 'chat', message: 'Patient used AI assistant', timestamp: new Date(Date.now() - 3600000 * 8).toISOString() },
    ],
    alerts: []
  };
}

let db = loadDB();
if (!db.alerts) db.alerts = [];

function saveDB() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function logActivity(patientId: string, type: string, message: string) {
  db.activity.unshift({
    id: `A${Date.now()}`, patientId, type, message,
    timestamp: new Date().toISOString()
  });
  if (db.activity.length > 200) db.activity = db.activity.slice(0, 200);
  saveDB();
}

// ── SSE clients for real-time alerts ─────────────────────────
let sseClients: any[] = [];

function broadcastAlert(alert: any) {
  const payload = JSON.stringify({ type: 'new_alert', alert });
  sseClients = sseClients.filter(res => {
    try { res.write(`data: ${payload}\n\n`); return true; }
    catch { return false; }
  });
}

// ── API ROUTES ────────────────────────────────────────────────

app.get('/api/ai-status', (req, res) => {
  res.json({ hasAny: !!process.env.GEMINI_API_KEY, active: 'Gemini' });
});

app.get('/api/patients', (req, res) => res.json(db.patients));

app.get('/api/patients/:id', (req, res) => {
  const p = db.patients.find((p: any) => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Patient not found' });
  res.json(p);
});

app.post('/api/patients', (req, res) => {
  const { name, age, stage, caregiver, phone, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const patient = {
    id: `P${Date.now()}`, name, age: age || '', stage: stage || 'Mild',
    caregiver: caregiver || '', phone: phone || '', notes: notes || '',
    createdAt: new Date().toISOString()
  };
  db.patients.push(patient);
  saveDB();
  res.status(201).json(patient);
});

app.patch('/api/patients/:id', (req, res) => {
  const p = db.patients.find((p: any) => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  ['name', 'age', 'stage', 'caregiver', 'phone', 'notes'].forEach(f => {
    if (req.body[f] !== undefined) p[f] = req.body[f];
  });
  saveDB();
  res.json(p);
});

app.delete('/api/patients/:id', (req, res) => {
  const idx = db.patients.findIndex((p: any) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.patients.splice(idx, 1);
  saveDB();
  res.json({ deleted: true });
});

app.get('/api/reminders', (req, res) => {
  const { patientId } = req.query;
  res.json(patientId ? db.reminders.filter((r: any) => r.patientId === patientId) : db.reminders);
});

app.post('/api/reminders', (req, res) => {
  const { patientId, type, label, time, days } = req.body;
  if (!patientId || !type || !label || !time) return res.status(400).json({ error: 'Missing fields' });
  const reminder = {
    id: `R${Date.now()}`, patientId, type, label, time,
    days: days || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    active: true, createdAt: new Date().toISOString()
  };
  db.reminders.push(reminder);
  saveDB();
  res.status(201).json(reminder);
});

app.patch('/api/reminders/:id', (req, res) => {
  const r = db.reminders.find((r: any) => r.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  ['type', 'label', 'time', 'days', 'active'].forEach(f => {
    if (req.body[f] !== undefined) r[f] = req.body[f];
  });
  saveDB();
  res.json(r);
});

app.delete('/api/reminders/:id', (req, res) => {
  const idx = db.reminders.findIndex((r: any) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.reminders.splice(idx, 1);
  saveDB();
  res.json({ deleted: true });
});

app.get('/api/activity', (req, res) => {
  const { patientId, limit } = req.query;
  let logs = patientId ? db.activity.filter((a: any) => a.patientId === patientId) : db.activity;
  if (limit) logs = logs.slice(0, parseInt(limit as string));
  res.json(logs);
});

app.post('/api/activity', (req, res) => {
  const { patientId, type, message } = req.body;
  logActivity(patientId, type, message);
  res.status(201).json({ logged: true });
});

app.get('/api/stats', (req, res) => {
  const recentActivity = db.activity.filter((a: any) =>
    new Date(a.timestamp) > new Date(Date.now() - 86400000)
  ).length;
  const unreadAlerts = (db.alerts || []).filter((a: any) => !a.read).length;
  res.json({
    patients: db.patients.length,
    activeReminders: db.reminders.filter((r: any) => r.active).length,
    activityToday: recentActivity,
    totalActivity: db.activity.length,
    unreadAlerts
  });
});

app.get('/api/alerts', (req, res) => {
  const { limit } = req.query;
  let alerts = [...(db.alerts || [])].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  if (limit) alerts = alerts.slice(0, parseInt(limit as string));
  res.json(alerts);
});

app.post('/api/alerts/send', (req, res) => {
  const { patientId, type, message, severity } = req.body;
  const patient = db.patients.find((p: any) => p.id === patientId);
  const alert = {
    id: `AL${Date.now()}`,
    patientId: patientId || 'unknown',
    patientName: patient?.name || 'Unknown Patient',
    type: type || 'help_request',
    message: message || 'Patient needs help',
    severity: severity || 'medium',
    read: false,
    timestamp: new Date().toISOString()
  };
  if (!db.alerts) db.alerts = [];
  db.alerts.unshift(alert);
  if (db.alerts.length > 100) db.alerts = db.alerts.slice(0, 100);
  saveDB();
  logActivity(patientId, 'patient_alert', `Alert sent: ${message}`);
  broadcastAlert(alert);
  res.json({ success: true, alert });
});

app.patch('/api/alerts/:id/read', (req, res) => {
  const alert = (db.alerts || []).find((a: any) => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'Not found' });
  alert.read = true;
  saveDB();
  res.json({ success: true });
});

app.delete('/api/alerts', (req, res) => {
  db.alerts = [];
  saveDB();
  res.json({ cleared: true });
});

app.get('/api/alerts/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const recent = (db.alerts || []).slice(0, 10);
  res.write(`data: ${JSON.stringify({ type: 'history', alerts: recent })}\n\n`);

  sseClients.push(res);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients = sseClients.filter(c => c !== res);
  });
});

// ── AI: ANALYZE IMAGE ─────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { images, patientId, patientName, context } = req.body;
  if (!images || !images.length) return res.status(400).json({ error: 'No images provided' });
  try {
    const ai = getGenAI();
    const patient = db.patients.find((p: any) => p.id === patientId);
    const name = patientName || patient?.name || 'the patient';
    const imageParts = images.slice(0, 4).map((img: any) => ({
      inlineData: { data: img.data, mimeType: img.mediaType || 'image/jpeg' }
    }));
    const prompt = SYSTEM_PROMPTS.ANALYZE(name, context || '');

    const result = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: { parts: [...imageParts, { text: prompt }] },
    });

    const rawResponse = result.text;
    const clean = rawResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse AI response');
    const analysis = JSON.parse(jsonMatch[0]);
    logActivity(patientId || 'unknown', 'analysis', `Image analysis: ${analysis.urgency} — ${(analysis.summary || '').slice(0, 80)}...`);
    res.json({ success: true, analysis, raw: rawResponse });
  } catch (e: any) {
    console.error('Analysis error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AI: CHAT ──────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, patientId, mode } = req.body;
  if (!messages || !messages.length) return res.status(400).json({ error: 'No messages' });
  try {
    const ai = getGenAI();
    const patient = db.patients.find((p: any) => p.id === patientId);
    const reminders = db.reminders.filter((r: any) => r.patientId === patientId && r.active);
    
    const systemInstruction = mode === 'patient' 
      ? SYSTEM_PROMPTS.CHAT_PATIENT(patient, reminders)
      : SYSTEM_PROMPTS.CHAT_CAREGIVER(patient);

    const chat = ai.chats.create({
      model: "gemini-3-flash-preview",
      config: { systemInstruction }
    });

    const lastMessage = messages[messages.length - 1].content;
    const result = await chat.sendMessage({ message: lastMessage });

    logActivity(patientId || 'unknown', 'chat', `${mode === 'patient' ? 'Patient' : 'Caregiver'} used AI assistant`);
    res.json({ success: true, response: result.text });
  } catch (e: any) {
    console.error('Chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AI: DAILY SUMMARY (Dual-LLM Logic) ────────────────────────
app.post('/api/summary', async (req, res) => {
  const { patientId } = req.body;
  const patient = db.patients.find((p: any) => p.id === patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  
  try {
    const ai = getGenAI();
    const logs = db.activity.filter((a: any) => a.patientId === patientId).slice(0, 30);
    const prompt = SYSTEM_PROMPTS.SUMMARY(patient, logs);

    // Primary Summary
    const result = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
    });

    // Auditor Verification (Self-Correction)
    const auditorPrompt = `Review the following care summary for accuracy and tone. Ensure it is professional and highlights critical risks.
    Summary: ${result.text}
    Original Logs: ${JSON.stringify(logs)}
    Return a refined version of the summary.`;

    const auditResult = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: auditorPrompt,
    });

    res.json({ success: true, summary: auditResult.text });
  } catch (e: any) {
    console.error('Summary error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AI: SUGGEST REMINDERS ─────────────────────────────────────
app.post('/api/suggest-reminders', async (req, res) => {
  const { patientId } = req.body;
  const patient = db.patients.find((p: any) => p.id === patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  try {
    const ai = getGenAI();
    const prompt = `Generate a personalized daily reminder schedule for a cognitive decline patient:
Name: ${patient.name}, Age: ${patient.age}, Stage: ${patient.stage}
Notes: ${patient.notes}

Return a JSON array of reminder objects. Each object must have:
- type: one of: meal, medication, bathroom, hydration, activity, social, sleep, grooming
- label: short friendly description
- time: in HH:MM format (24hr)
- days: array of day abbreviations like ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]

Include 8-12 reminders spread across the day.
Respond with a JSON array ONLY. No markdown, no extra text.`;

    const result = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
    });

    const rawResponse = result.text;
    const clean = rawResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = clean.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('Could not parse suggestions');
    const suggestions = JSON.parse(jsonMatch[0]);
    res.json({ success: true, suggestions });
  } catch (e: any) {
    console.error('Suggest error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── VITE MIDDLEWARE ───────────────────────────────────────────

async function startServer() {
  // API routes first
  // ... (already defined above)

  // Serve landing.html at root
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'landing.html'));
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
