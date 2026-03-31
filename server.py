# ============================================================
#  CogniCare — Python Flask Backend
#
#  Required env variable:
#    GEMINI_API_KEY  — free at aistudio.google.com
#
#  Run locally:
#    pip install -r requirements.txt
#    python server.py
#
#  Deploy on Render:
#    Build command: pip install -r requirements.txt
#    Start command: gunicorn server:app
# ============================================================

import os
import json
import time
import queue
import threading
import base64
import re
from datetime import datetime, timedelta
from pathlib import Path

import requests
import google.generativeai as genai
from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context
from flask_cors import CORS

app = Flask(__name__, static_folder='public')
CORS(app)

# ── Config ───────────────────────────────────────────────────
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', '')
PORT           = int(os.environ.get('PORT', 3000))

# All known free Gemini models — tried in order until one works
MODEL_CANDIDATES = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash-lite-001',
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
    'gemini-pro-latest',
    'gemini-2.5-pro',
]

active_model = None   # set at startup by detect_working_model()

if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)

# ── SSE: connected caregiver clients ─────────────────────────
sse_queues = []   # list of queue.Queue objects, one per connected caregiver
sse_lock   = threading.Lock()

def broadcast_alert(alert_data: dict):
    payload = f"data: {json.dumps(alert_data)}\n\n"
    with sse_lock:
        dead = []
        for q in sse_queues:
            try:
                q.put_nowait(payload)
            except queue.Full:
                dead.append(q)
        for q in dead:
            sse_queues.remove(q)
    print(f"[ALERT] Broadcast to {len(sse_queues)} client(s): {alert_data.get('alert', {}).get('message', '')}")

# ── DB ────────────────────────────────────────────────────────
DATA_DIR = Path(__file__).parent / 'data'
DB_FILE  = DATA_DIR / 'db.json'

def now_iso():
    return datetime.utcnow().isoformat() + 'Z'

def days_ago_iso(n):
    return (datetime.utcnow() - timedelta(days=n)).isoformat() + 'Z'

DEFAULT_DB = {
    'patients': [{
        'id': 'P001', 'name': 'Margaret Thompson', 'age': 78, 'stage': 'Moderate',
        'caregiver': 'Susan Thompson', 'phone': '(416) 555-0123',
        'notes': 'Former schoolteacher. Enjoys classical music and gardening. Trouble with recent memory but long-term memory intact.',
        'createdAt': now_iso()
    }],
    'reminders': [
        {'id':'R001','patientId':'P001','type':'meal',       'label':'Breakfast',           'time':'08:00','days':['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],'active':True,'createdAt':now_iso()},
        {'id':'R002','patientId':'P001','type':'medication', 'label':'Morning medication',   'time':'09:00','days':['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],'active':True,'createdAt':now_iso()},
        {'id':'R003','patientId':'P001','type':'meal',       'label':'Lunch',               'time':'12:30','days':['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],'active':True,'createdAt':now_iso()},
        {'id':'R004','patientId':'P001','type':'bathroom',   'label':'Bathroom break',      'time':'14:00','days':['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],'active':True,'createdAt':now_iso()},
        {'id':'R005','patientId':'P001','type':'medication', 'label':'Afternoon medication', 'time':'15:00','days':['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],'active':True,'createdAt':now_iso()},
        {'id':'R006','patientId':'P001','type':'meal',       'label':'Dinner',              'time':'18:00','days':['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],'active':True,'createdAt':now_iso()},
        {'id':'R007','patientId':'P001','type':'hydration',  'label':'Drink water',         'time':'10:00','days':['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],'active':True,'createdAt':now_iso()},
        {'id':'R008','patientId':'P001','type':'activity',   'label':'Short walk outside',  'time':'11:00','days':['Mon','Wed','Fri'],                       'active':True,'createdAt':now_iso()},
    ],
    'activity': [
        {'id':'A001','patientId':'P001','type':'reminder_sent','message':'Breakfast reminder sent',                                'timestamp':days_ago_iso(0)},
        {'id':'A002','patientId':'P001','type':'analysis',     'message':'Image analysis completed — no concerning signs observed','timestamp':days_ago_iso(0)},
        {'id':'A003','patientId':'P001','type':'chat',         'message':'Patient used AI assistant',                             'timestamp':days_ago_iso(0)},
    ],
    'alerts': []
}

def load_db():
    try:
        if DB_FILE.exists():
            return json.loads(DB_FILE.read_text())
    except Exception as e:
        print(f'DB load error: {e}')
    return DEFAULT_DB.copy()

def save_db():
    DATA_DIR.mkdir(exist_ok=True)
    DB_FILE.write_text(json.dumps(db, indent=2))

def log_activity(patient_id, type_, message):
    db['activity'].insert(0, {
        'id': f'A{int(time.time()*1000)}',
        'patientId': patient_id,
        'type': type_,
        'message': message,
        'timestamp': now_iso()
    })
    if len(db['activity']) > 200:
        db['activity'] = db['activity'][:200]
    save_db()

db = load_db()
if 'alerts' not in db:
    db['alerts'] = []

# ── Safety rules ──────────────────────────────────────────────
SAFETY_RULES = [
    {'id':'stove',     'keywords':['stove','oven','burner','cooktop','gas','flame','cooking','hob'],     'patient_reminder':'Please remember to turn off the stove when you are done cooking. Safety first! 🔥', 'caregiver_alert':'Patient appears to be using the stove. Please monitor and ensure it is turned off after use.','severity':'high'},
    {'id':'knife',     'keywords':['knife','knives','blade','chopping','cutting','scissors','sharp'],    'patient_reminder':'Please be very careful with sharp objects. Take your time and stay safe. 🔪',          'caregiver_alert':'Patient appears to be handling a knife or sharp object. Please supervise.','severity':'high'},
    {'id':'stairs',    'keywords':['stairs','staircase','steps','ladder','climbing','descending'],       'patient_reminder':'Please hold the handrail tightly when going up or down the stairs. Take it slowly. 🪜','caregiver_alert':'Patient is near stairs. Fall risk — please ensure they use the handrail.','severity':'medium'},
    {'id':'medication','keywords':['pill','pills','medication','medicine','bottle','tablets','capsules'], 'patient_reminder':'If those are your medications, only take the ones your caregiver has prepared for you. 💊','caregiver_alert':'Patient appears to be handling medications. Please verify they are taking the correct dose.','severity':'high'},
    {'id':'water',     'keywords':['tap','faucet','running water','sink','bath','bathtub','shower'],     'patient_reminder':'Please remember to turn off the tap when you are finished. 🚿',                        'caregiver_alert':'Patient is using water fixtures. Please check taps are turned off properly.','severity':'medium'},
    {'id':'door',      'keywords':['door','front door','exit','outside','leaving','wandering','gate'],   'patient_reminder':'Please stay inside where it is safe and warm. Your caregiver will be with you soon. 🚪','caregiver_alert':'Patient appears to be near an exit door. Wandering risk — please check immediately.','severity':'critical'},
    {'id':'fall_risk', 'keywords':['wet floor','slippery','standing on chair','unstable','socks only'], 'patient_reminder':'Please be careful — the floor may be slippery. Hold on to something steady. 🛑',         'caregiver_alert':'Potential fall hazard detected. Please check and make the area safe.','severity':'high'},
    {'id':'iron',      'keywords':['iron','ironing','ironing board','steam iron'],                      'patient_reminder':'Please remember to turn off the iron when you are finished. It gets very hot! 👕',      'caregiver_alert':'Patient is using an iron. Please ensure it is unplugged after use.','severity':'high'},
    {'id':'kettle',    'keywords':['kettle','boiling water','hot water','steam','tea'],                  'patient_reminder':'Be careful — the kettle and water are very hot. Pour slowly and carefully. ☕',         'caregiver_alert':'Patient is using a kettle with boiling water. Please monitor for burn risk.','severity':'medium'},
    {'id':'electrical','keywords':['electrical','socket','plug','wire','cables','extension cord'],       'patient_reminder':'Please do not touch electrical sockets or wires. Ask your caregiver for help. ⚡',     'caregiver_alert':'Patient is near electrical hazards. Please supervise and make area safe.','severity':'critical'},
    {'id':'cleaning',  'keywords':['cleaning products','bleach','chemicals','spray bottle','detergent'], 'patient_reminder':'Please do not touch cleaning products — they can be harmful. Ask your caregiver. 🧴',  'caregiver_alert':'Patient is handling cleaning products. Please supervise immediately.','severity':'critical'},
    {'id':'outside',   'keywords':['outside alone','garden alone','yard alone','street','road'],         'patient_reminder':'Please stay close to home. Let your caregiver know before going outside. 🏡',            'caregiver_alert':'Patient appears to be outside or in the garden alone. Please check on them.','severity':'high'},
]

# ── Gemini helpers ────────────────────────────────────────────

def clean_json(text: str) -> str:
    """Strip markdown code fences Gemini sometimes adds."""
    text = re.sub(r'```json\n?', '', text)
    text = re.sub(r'```\n?', '', text)
    return text.strip()

def detect_working_model() -> str | None:
    """Try each model until one responds successfully."""
    if not GEMINI_API_KEY:
        print('  ⚠  No GEMINI_API_KEY set')
        return None
    print('  🔍 Auto-detecting working Gemini model...')
    for model_id in MODEL_CANDIDATES:
        try:
            model  = genai.GenerativeModel(model_id)
            result = model.generate_content('Say ok')
            if result.text:
                print(f'  ✓  Working model: {model_id}')
                return model_id
        except Exception as e:
            print(f'  ✗  {model_id}: {str(e)[:80]}')
    print('  ✗  No working model found — check your API key')
    return None

def gemini_text(prompt: str, system: str = '') -> str:
    """Single-turn text generation."""
    if not active_model:
        raise RuntimeError('No working Gemini model available. Check GEMINI_API_KEY.')
    for model_id in [active_model] + [m for m in MODEL_CANDIDATES if m != active_model]:
        try:
            model = genai.GenerativeModel(
                model_id,
                system_instruction=system if system else None
            )
            result = model.generate_content(prompt)
            return result.text
        except Exception as e:
            msg = str(e)
            if '404' in msg or '429' in msg or 'not found' in msg.lower():
                continue
            raise
    raise RuntimeError('No working Gemini model available.')

def gemini_chat(history: list, system: str = '') -> str:
    """Multi-turn chat."""
    if not active_model:
        raise RuntimeError('No working Gemini model available. Check GEMINI_API_KEY.')
    for model_id in [active_model] + [m for m in MODEL_CANDIDATES if m != active_model]:
        try:
            model = genai.GenerativeModel(
                model_id,
                system_instruction=system if system else None
            )
            # Convert to Gemini format
            gemini_history = []
            for msg in history[:-1]:
                gemini_history.append({
                    'role':  'model' if msg['role'] == 'assistant' else 'user',
                    'parts': [msg['content']]
                })
            chat   = model.start_chat(history=gemini_history)
            result = chat.send_message(history[-1]['content'])
            return result.text
        except Exception as e:
            msg = str(e)
            if '404' in msg or '429' in msg or 'not found' in msg.lower():
                continue
            raise
    raise RuntimeError('No working Gemini model available.')

def gemini_vision(image_parts: list, prompt: str) -> str:
    """Multimodal image + text generation."""
    if not active_model:
        raise RuntimeError('No working Gemini model available. Check GEMINI_API_KEY.')
    for model_id in [active_model] + [m for m in MODEL_CANDIDATES if m != active_model]:
        try:
            model   = genai.GenerativeModel(model_id)
            content = image_parts + [prompt]
            result  = model.generate_content(content)
            return result.text
        except Exception as e:
            msg = str(e)
            if '404' in msg or '429' in msg or 'not found' in msg.lower():
                continue
            raise
    raise RuntimeError('No working Gemini model available.')

# ── YouTube helpers ───────────────────────────────────────────

def extract_youtube_id(url: str) -> str | None:
    patterns = [
        r'(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/)([^&\n?#]+)',
        r'youtube\.com/shorts/([^&\n?#]+)'
    ]
    for p in patterns:
        m = re.search(p, url)
        if m:
            return m.group(1)
    return None

def get_youtube_data(video_id: str) -> dict:
    thumb_urls = [
        f'https://img.youtube.com/vi/{video_id}/maxresdefault.jpg',
        f'https://img.youtube.com/vi/{video_id}/hqdefault.jpg',
        f'https://img.youtube.com/vi/{video_id}/mqdefault.jpg',
    ]
    images = []
    for url in thumb_urls:
        try:
            r = requests.get(url, timeout=5)
            if r.ok and len(r.content) > 5000:
                images.append({
                    'data':      base64.b64encode(r.content).decode(),
                    'mediaType': 'image/jpeg'
                })
        except Exception:
            pass

    metadata = {'title': 'Unknown', 'author': 'Unknown'}
    try:
        r = requests.get(
            f'https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json',
            timeout=5
        )
        if r.ok:
            d = r.json()
            metadata['title']  = d.get('title', 'Unknown')
            metadata['author'] = d.get('author_name', 'Unknown')
    except Exception:
        pass

    return {
        'images':   images,
        'metadata': metadata,
        'videoId':  video_id,
        'videoUrl': f'https://www.youtube.com/watch?v={video_id}'
    }

# ── Serve frontend static files ───────────────────────────────

@app.route('/')
def index():
    return send_from_directory('public', 'index.html')

@app.route('/<path:filename>')
def static_files(filename):
    try:
        return send_from_directory('public', filename)
    except Exception:
        return send_from_directory('public', 'index.html')

# ═══════════════════════════════════════════════════════════════
#  API ROUTES
# ═══════════════════════════════════════════════════════════════

# ── AI status ─────────────────────────────────────────────────
@app.get('/api/ai-status')
def ai_status():
    return jsonify({
        'hasKey':      bool(GEMINI_API_KEY),
        'activeModel': active_model or 'none',
        'ready':       bool(GEMINI_API_KEY and active_model),
        'status':      (f'✓ Ready — {active_model}' if active_model
                        else ('✗ No API key' if not GEMINI_API_KEY else '✗ No working model'))
    })

# ── SSE: real-time caregiver alerts ──────────────────────────
@app.get('/api/alerts/stream')
def alerts_stream():
    q = queue.Queue(maxsize=50)
    with sse_lock:
        sse_queues.append(q)

    # Send recent unread alerts on connect
    recent = db['alerts'][:5]
    if recent:
        q.put_nowait(f"data: {json.dumps({'type':'history','alerts':recent})}\n\n")

    def generate():
        try:
            while True:
                try:
                    msg = q.get(timeout=25)
                    yield msg
                except queue.Empty:
                    yield ': ping\n\n'   # keep-alive
        finally:
            with sse_lock:
                if q in sse_queues:
                    sse_queues.remove(q)

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control':               'no-cache',
            'X-Accel-Buffering':           'no',
            'Access-Control-Allow-Origin': '*',
        }
    )

# ── Send patient alert ────────────────────────────────────────
@app.post('/api/alerts/send')
def send_alert():
    data       = request.json or {}
    message    = data.get('message')
    if not message:
        return jsonify({'error': 'Message required'}), 400

    patient_id = data.get('patientId', 'unknown')
    patient    = next((p for p in db['patients'] if p['id'] == patient_id), None)

    alert = {
        'id':          f'ALT{int(time.time()*1000)}',
        'patientId':   patient_id,
        'patientName': patient['name'] if patient else 'Patient',
        'type':        data.get('type', 'help_request'),
        'message':     message,
        'severity':    data.get('severity', 'high'),
        'timestamp':   now_iso(),
        'read':        False
    }

    db['alerts'].insert(0, alert)
    if len(db['alerts']) > 100:
        db['alerts'] = db['alerts'][:100]
    save_db()

    log_activity(patient_id, 'patient_alert', f"🚨 {alert['patientName']}: {message}")
    broadcast_alert({'type': 'new_alert', 'alert': alert})

    return jsonify({'success': True, 'alert': alert}), 201

@app.get('/api/alerts')
def get_alerts():
    limit = int(request.args.get('limit', 20))
    return jsonify(db['alerts'][:limit])

@app.patch('/api/alerts/<alert_id>/read')
def mark_alert_read(alert_id):
    alert = next((a for a in db['alerts'] if a['id'] == alert_id), None)
    if not alert:
        return jsonify({'error': 'Not found'}), 404
    alert['read'] = True
    save_db()
    return jsonify({'success': True})

@app.delete('/api/alerts')
def clear_alerts():
    db['alerts'] = []
    save_db()
    return jsonify({'success': True})

# ── YouTube info ──────────────────────────────────────────────
@app.post('/api/youtube-info')
def youtube_info():
    url      = (request.json or {}).get('url')
    if not url:
        return jsonify({'error': 'URL required'}), 400
    video_id = extract_youtube_id(url)
    if not video_id:
        return jsonify({'error': 'Invalid YouTube URL'}), 400
    try:
        data = get_youtube_data(video_id)
        return jsonify({'success': True, **data})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ── Image / YouTube analysis ──────────────────────────────────
@app.post('/api/analyze')
def analyze():
    data            = request.json or {}
    images_raw      = data.get('images', [])
    patient_id      = data.get('patientId', '')
    patient_name    = data.get('patientName', '')
    context         = data.get('context', '')
    youtube_url     = data.get('youtubeUrl', '')

    images_to_analyze = list(images_raw)
    video_context     = context

    if youtube_url:
        video_id = extract_youtube_id(youtube_url)
        if not video_id:
            return jsonify({'error': 'Invalid YouTube URL'}), 400
        yt_data           = get_youtube_data(video_id)
        images_to_analyze += yt_data['images']
        video_context      = f'YouTube: "{yt_data["metadata"]["title"]}" by {yt_data["metadata"]["author"]}. {context}'

    if not images_to_analyze:
        return jsonify({'error': 'No images provided'}), 400

    patient = next((p for p in db['patients'] if p['id'] == patient_id), None)
    name    = patient_name or (patient['name'] if patient else 'the patient')

    # Build Gemini image parts
    image_parts = []
    for img in images_to_analyze[:4]:
        image_parts.append({
            'mime_type': img.get('mediaType', 'image/jpeg'),
            'data':      img['data']
        })
    gemini_parts = [genai.protos.Part(
        inline_data=genai.protos.Blob(mime_type=p['mime_type'], data=base64.b64decode(p['data']))
    ) for p in image_parts]

    patient_info = (f"{patient['name']}, Age: {patient['age']}, Stage: {patient['stage']}, Notes: {patient['notes']}"
                    if patient else 'Unknown')

    prompt = f"""You are a compassionate AI medical assistant for cognitive decline monitoring.
Analyze this image/video of {name} carefully.

Patient: {patient_info}
{f'Context: {video_context}' if video_context else ''}

IMPORTANT — also look specifically for ANY of these safety hazards:
- Stove, oven, cooktop, flame, or cooking in progress
- Knife, scissors, or sharp objects being handled
- Stairs, ladder, or climbing
- Medications or pill bottles
- Running taps, bath, shower, or flooding risk
- Front door, exit, or signs of wandering
- Wet/slippery floor, unstable surfaces, no footwear
- Iron or ironing board in use
- Kettle or boiling water
- Electrical sockets, exposed wires
- Cleaning chemicals, bleach, spray bottles
- Being outside or in garden alone

Return ONLY this JSON no markdown:
{{
  "observations": [],
  "cognitiveIndicators": {{
    "confusion": "none|mild|moderate|severe",
    "agitation": "none|mild|moderate|severe",
    "disorientation": "none|mild|moderate|severe",
    "expressionConcern": "none|mild|moderate|severe"
  }},
  "physicalIndicators": {{
    "posture": "",
    "mobility": "",
    "grooming": "",
    "fatigue": "none|mild|moderate|severe"
  }},
  "immediateNeeds": [],
  "recommendations": [],
  "urgency": "routine|attention|urgent",
  "summary": "",
  "safetyFlags": [],
  "hazardsDetected": [
    {{
      "hazard": "name of hazard e.g. stove, knife, stairs",
      "description": "what exactly you see",
      "riskLevel": "low|medium|high|critical",
      "patientMessage": "Short warm gentle reminder TO the patient (max 2 sentences)",
      "caregiverMessage": "Clear alert message FOR the caregiver"
    }}
  ]
}}

If no hazards detected, hazardsDetected must be [].
Be thorough — patient safety is the priority."""

    try:
        raw      = gemini_vision(gemini_parts, prompt)
        clean    = clean_json(raw)
        match    = re.search(r'\{[\s\S]*\}', clean)
        if not match:
            return jsonify({'error': 'AI did not return valid JSON — please try again'}), 500
        analysis = json.loads(match.group())

        # Auto-send caregiver alerts for detected hazards
        hazards     = analysis.get('hazardsDetected', [])
        auto_alerts = []

        for hazard in hazards:
            hazard_name = hazard.get('hazard', '')
            desc        = hazard.get('description', '')

            # Match safety rule
            rule = None
            for r in SAFETY_RULES:
                if any(k in hazard_name.lower() or k in desc.lower() for k in r['keywords']):
                    rule = r
                    break

            alert_msg = (rule['caregiver_alert'] if rule
                         else hazard.get('caregiverMessage', f'Hazard: {hazard_name} — {desc}'))
            severity_map = {'critical': 'urgent', 'high': 'high', 'medium': 'medium', 'low': 'low'}
            severity = severity_map.get(hazard.get('riskLevel', 'medium'), 'medium')

            if rule:
                hazard['patientMessage'] = rule['patient_reminder']

            alert = {
                'id':          f'ALT{int(time.time()*1000)}{len(auto_alerts)}',
                'patientId':   patient_id or 'unknown',
                'patientName': patient['name'] if patient else 'Patient',
                'type':        'safety_hazard',
                'message':     f'⚠️ Safety: {alert_msg}',
                'severity':    severity,
                'timestamp':   now_iso(),
                'read':        False
            }
            db['alerts'].insert(0, alert)
            broadcast_alert({'type': 'new_alert', 'alert': alert})
            auto_alerts.append(alert)

        if auto_alerts:
            save_db()

        log_activity(
            patient_id or 'unknown', 'analysis',
            f"Analysis ({'YouTube' if youtube_url else 'image'}): {analysis.get('urgency', '?')}"
            + (f" — ⚠️ {len(hazards)} hazard(s): {', '.join(h.get('hazard','') for h in hazards)}"
               if hazards else ' — no hazards')
        )

        return jsonify({'success': True, 'analysis': analysis, 'modelUsed': active_model,
                        'autoAlertsSent': len(auto_alerts)})

    except Exception as e:
        print(f'Analysis error: {e}')
        return jsonify({'error': str(e)}), 500

# ── Chat ──────────────────────────────────────────────────────
@app.post('/api/chat')
def chat():
    data       = request.json or {}
    messages   = data.get('messages', [])
    patient_id = data.get('patientId', '')
    mode       = data.get('mode', 'caregiver')

    if not messages:
        return jsonify({'error': 'No messages'}), 400

    patient   = next((p for p in db['patients'] if p['id'] == patient_id), None)
    reminders = [r for r in db['reminders'] if r['patientId'] == patient_id and r['active']]

    if mode == 'patient':
        reminder_str = ', '.join(f"{r['time']} — {r['label']}" for r in reminders) or 'None'
        system = (
            f"You are a warm gentle AI companion for {patient['name'] if patient else 'a person'} who has cognitive decline.\n"
            f"- Speak in SIMPLE SHORT sentences. Max 3 sentences per response.\n"
            f"- Be extremely warm, reassuring and positive at all times.\n"
            f"- If confused, gently orient them by telling them the day and time.\n"
            f"- If they mention pain, a fall, or distress, tell them to press the red emergency button immediately.\n"
            f"- Use their first name often. Never correct harshly — redirect gently.\n"
            f"Patient: {patient['name'] + ', Age ' + str(patient['age']) + ', Stage: ' + patient['stage'] if patient else 'Unknown'}\n"
            f"Reminders today: {reminder_str}"
        )
    else:
        system = (
            f"You are an expert compassionate AI assistant for caregivers managing cognitive decline patients.\n"
            f"You help with behavioral changes, care strategies, communication techniques, managing agitation and sundowning,\n"
            f"caregiver burnout, understanding disease stages, safety assessments, and activities for cognitive stimulation.\n"
            f"Always be evidence-based and remind caregivers to consult medical professionals for clinical decisions.\n"
            f"Patient: {patient['name'] + ', Age: ' + str(patient['age']) + ', Stage: ' + patient['stage'] + '. Notes: ' + patient['notes'] if patient else 'Not specified'}"
        )

    try:
        response = gemini_chat(messages, system)
        log_activity(patient_id or 'unknown', 'chat',
                     f"{'Patient' if mode == 'patient' else 'Caregiver'} used AI assistant")
        return jsonify({'success': True, 'response': response, 'modelUsed': active_model})
    except Exception as e:
        print(f'Chat error: {e}')
        return jsonify({'error': str(e)}), 500

# ── Suggest reminders ─────────────────────────────────────────
@app.post('/api/suggest-reminders')
def suggest_reminders():
    patient_id = (request.json or {}).get('patientId')
    patient    = next((p for p in db['patients'] if p['id'] == patient_id), None)
    if not patient:
        return jsonify({'error': 'Patient not found'}), 404

    prompt = (
        f"Generate a personalized daily reminder schedule for this cognitive decline patient:\n"
        f"Name: {patient['name']}, Age: {patient['age']}, Stage: {patient['stage']}\n"
        f"Background: {patient['notes']}\n\n"
        f"Return ONLY a JSON array. Each item must have:\n"
        f"- type: meal|medication|bathroom|hydration|activity|social|sleep|grooming\n"
        f"- label: warm friendly short description\n"
        f"- time: HH:MM 24hr format\n"
        f"- days: [\"Mon\",\"Tue\",\"Wed\",\"Thu\",\"Fri\",\"Sat\",\"Sun\"]\n\n"
        f"8-12 reminders spread across the day. JSON array ONLY, no markdown."
    )
    try:
        raw   = gemini_text(prompt)
        clean = clean_json(raw)
        match = re.search(r'\[[\s\S]*\]', clean)
        if not match:
            return jsonify({'error': 'Could not parse suggestions'}), 500
        return jsonify({'success': True, 'suggestions': json.loads(match.group()), 'modelUsed': active_model})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ── JSON data analysis ────────────────────────────────────────
@app.post('/api/json-analyze')
def json_analyze():
    data       = request.json or {}
    json_data  = data.get('jsonData')
    patient_id = data.get('patientId', '')
    data_type  = data.get('dataType', 'General health data')
    date_str   = data.get('date', datetime.utcnow().strftime('%Y-%m-%d'))

    if not json_data:
        return jsonify({'error': 'No JSON data provided'}), 400

    if isinstance(json_data, str):
        try:
            json_data = json.loads(json_data)
        except json.JSONDecodeError as e:
            return jsonify({'error': f'Invalid JSON: {e}'}), 400

    patient = next((p for p in db['patients'] if p['id'] == patient_id), None)
    patient_info = (f"{patient['name']}, Age: {patient['age']}, Stage: {patient['stage']}. Notes: {patient['notes']}"
                    if patient else 'Unknown')

    prompt = f"""You are a compassionate AI medical assistant for cognitive decline monitoring.
Patient: {patient_info}
Data type: {data_type}, Date: {date_str}
JSON data: {json.dumps(json_data, indent=2)}

Return ONLY this JSON no markdown:
{{
  "dailySummary": {{
    "overview": "2-3 sentence overview",
    "overallStatus": "good|fair|concerning|critical",
    "keyFindings": [],
    "positives": [],
    "concerns": []
  }},
  "alerts": [
    {{
      "priority": "low|medium|high|critical",
      "category": "medication|nutrition|hydration|mobility|cognitive|safety|social|sleep|other",
      "title": "",
      "description": "",
      "action": ""
    }}
  ],
  "recommendations": [
    {{"timeframe": "immediate|today|this_week", "text": ""}}
  ],
  "metricsExtracted": {{}},
  "nextCheckIn": ""
}}

Sort alerts by priority. Be thorough and compassionate."""

    try:
        raw   = gemini_text(prompt)
        clean = clean_json(raw)
        match = re.search(r'\{[\s\S]*\}', clean)
        if not match:
            return jsonify({'error': 'AI did not return valid JSON'}), 500
        result = json.loads(match.group())

        alert_count = len(result.get('alerts', []))
        high_alerts = [a for a in result.get('alerts', []) if a.get('priority') in ('high', 'critical')]

        # Auto-broadcast high/critical alerts
        for a in high_alerts:
            sys_alert = {
                'id':          f'ALT{int(time.time()*1000)}',
                'patientId':   patient_id or 'unknown',
                'patientName': patient['name'] if patient else 'Patient',
                'type':        'json_alert',
                'message':     f"{a['title']} — {a['description'][:100]}",
                'severity':    a['priority'],
                'timestamp':   now_iso(),
                'read':        False
            }
            db['alerts'].insert(0, sys_alert)
            broadcast_alert({'type': 'new_alert', 'alert': sys_alert})

        if high_alerts:
            save_db()

        log_activity(patient_id or 'unknown', 'json_analysis',
                     f"JSON analysis: {result.get('dailySummary', {}).get('overallStatus', 'unknown')} "
                     f"— {alert_count} alerts ({len(high_alerts)} high/critical)")

        return jsonify({'success': True, 'result': result, 'modelUsed': active_model})

    except Exception as e:
        print(f'JSON analyze error: {e}')
        return jsonify({'error': str(e)}), 500

# ── Patients CRUD ─────────────────────────────────────────────
@app.get('/api/patients')
def get_patients():
    return jsonify(db['patients'])

@app.get('/api/patients/<patient_id>')
def get_patient(patient_id):
    p = next((p for p in db['patients'] if p['id'] == patient_id), None)
    if not p:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(p)

@app.post('/api/patients')
def create_patient():
    data = request.json or {}
    if not data.get('name'):
        return jsonify({'error': 'Name required'}), 400
    p = {
        'id': f'P{int(time.time()*1000)}',
        'name':      data.get('name'),
        'age':       data.get('age', ''),
        'stage':     data.get('stage', 'Mild'),
        'caregiver': data.get('caregiver', ''),
        'phone':     data.get('phone', ''),
        'notes':     data.get('notes', ''),
        'createdAt': now_iso()
    }
    db['patients'].append(p)
    save_db()
    return jsonify(p), 201

@app.patch('/api/patients/<patient_id>')
def update_patient(patient_id):
    p = next((p for p in db['patients'] if p['id'] == patient_id), None)
    if not p:
        return jsonify({'error': 'Not found'}), 404
    data = request.json or {}
    for f in ['name', 'age', 'stage', 'caregiver', 'phone', 'notes']:
        if f in data:
            p[f] = data[f]
    save_db()
    return jsonify(p)

@app.delete('/api/patients/<patient_id>')
def delete_patient(patient_id):
    idx = next((i for i, p in enumerate(db['patients']) if p['id'] == patient_id), None)
    if idx is None:
        return jsonify({'error': 'Not found'}), 404
    db['patients'].pop(idx)
    save_db()
    return jsonify({'deleted': True})

# ── Reminders CRUD ────────────────────────────────────────────
@app.get('/api/reminders')
def get_reminders():
    patient_id = request.args.get('patientId')
    reminders  = db['reminders']
    if patient_id:
        reminders = [r for r in reminders if r['patientId'] == patient_id]
    return jsonify(reminders)

@app.post('/api/reminders')
def create_reminder():
    data = request.json or {}
    if not all(data.get(f) for f in ['patientId', 'type', 'label', 'time']):
        return jsonify({'error': 'Missing fields'}), 400
    r = {
        'id':        f'R{int(time.time()*1000)}',
        'patientId': data['patientId'],
        'type':      data['type'],
        'label':     data['label'],
        'time':      data['time'],
        'days':      data.get('days', ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']),
        'active':    True,
        'createdAt': now_iso()
    }
    db['reminders'].append(r)
    save_db()
    return jsonify(r), 201

@app.patch('/api/reminders/<reminder_id>')
def update_reminder(reminder_id):
    r = next((r for r in db['reminders'] if r['id'] == reminder_id), None)
    if not r:
        return jsonify({'error': 'Not found'}), 404
    data = request.json or {}
    for f in ['type', 'label', 'time', 'days', 'active']:
        if f in data:
            r[f] = data[f]
    save_db()
    return jsonify(r)

@app.delete('/api/reminders/<reminder_id>')
def delete_reminder(reminder_id):
    idx = next((i for i, r in enumerate(db['reminders']) if r['id'] == reminder_id), None)
    if idx is None:
        return jsonify({'error': 'Not found'}), 404
    db['reminders'].pop(idx)
    save_db()
    return jsonify({'deleted': True})

# ── Activity + Stats ──────────────────────────────────────────
@app.get('/api/activity')
def get_activity():
    patient_id = request.args.get('patientId')
    limit      = int(request.args.get('limit', 50))
    logs       = db['activity']
    if patient_id:
        logs = [a for a in logs if a['patientId'] == patient_id]
    return jsonify(logs[:limit])

@app.post('/api/activity')
def post_activity():
    data = request.json or {}
    log_activity(data.get('patientId', 'unknown'), data.get('type', 'event'), data.get('message', ''))
    return jsonify({'logged': True}), 201

@app.get('/api/stats')
def get_stats():
    cutoff     = (datetime.utcnow() - timedelta(days=1)).isoformat()
    return jsonify({
        'patients':        len(db['patients']),
        'activeReminders': sum(1 for r in db['reminders'] if r['active']),
        'activityToday':   sum(1 for a in db['activity'] if a['timestamp'] > cutoff),
        'totalActivity':   len(db['activity']),
        'unreadAlerts':    sum(1 for a in db['alerts'] if not a['read'])
    })

# ═══════════════════════════════════════════════════════════════
#  STARTUP
# ═══════════════════════════════════════════════════════════════
if __name__ == '__main__':
    print()
    print('  🧠  CogniCare AI Assistant (Python)')
    print(f'  ●   http://localhost:{PORT}')
    print(f'  🔑  API Key: {"✓ Set" if GEMINI_API_KEY else "✗ Missing — get free key at aistudio.google.com"}')
    print()

    if GEMINI_API_KEY:
        active_model = detect_working_model()
        if active_model:
            print(f'  🚀  Ready — using: {active_model}')
        else:
            print('  ⚠   No working model found. Check your API key.')
    print()

    app.run(host='0.0.0.0', port=PORT, debug=False)
else:
    # Running via gunicorn — detect model at module load time
    if GEMINI_API_KEY:
        active_model = detect_working_model()
