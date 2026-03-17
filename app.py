"""
Monitor NEXO — Backend Flask
Plataforma de Monitoramento Assistencial
"""

import sqlite3, os, io, csv, secrets, smtplib, threading
from datetime import date, datetime, timedelta
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from functools import wraps
from flask import Flask, request, jsonify, send_from_directory, Response, session

from werkzeug.security import generate_password_hash, check_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH  = os.path.join(BASE_DIR, 'uti.db')
PUB_DIR  = os.path.join(BASE_DIR, 'public')

app = Flask(__name__, static_folder=PUB_DIR)
app.secret_key = os.environ.get('FLASK_SECRET_KEY', secrets.token_hex(32))
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(hours=12)

# ─── Email config (Gmail SMTP) ─────────────────────────────
# Set these environment variables to enable email notifications:
#   SMTP_USER=your-email@gmail.com
#   SMTP_PASS=your-app-password
#   SMTP_HOST=smtp.gmail.com (default)
#   SMTP_PORT=587 (default)
SMTP_HOST = os.environ.get('SMTP_HOST', 'smtp.gmail.com')
SMTP_PORT = int(os.environ.get('SMTP_PORT', '587'))
SMTP_USER = os.environ.get('SMTP_USER', '')
SMTP_PASS = os.environ.get('SMTP_PASS', '')
ADMIN_EMAIL = 'danielvgloria@gmail.com'
APP_URL = os.environ.get('APP_URL', 'http://localhost:3000')

# ─────────────────────────────────────────────
#  DATABASE
# ─────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def migrate_db(conn):
    """Renomeia tabelas da v1 se existirem com schema antigo e adiciona colunas novas."""
    cols = [r[1] for r in conn.execute("PRAGMA table_info(checklists)").fetchall()]
    if cols and 'paciente_id' in cols and 'ocupacao_id' not in cols:
        conn.execute("ALTER TABLE checklists RENAME TO checklists_v1_legacy")
        return
    if cols:
        new_cols = {
            'reavaliacao_atb': 'TEXT',
            'dias_vm': 'INTEGER',
            'dias_cvc': 'INTEGER',
            'dias_sonda': 'INTEGER',
            'previsao_alta': 'TEXT',
        }
        for col, typ in new_cols.items():
            if col not in cols:
                conn.execute(f"ALTER TABLE checklists ADD COLUMN {col} {typ}")

def init_db():
    with get_db() as conn:
        migrate_db(conn)
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS utis (
                id    INTEGER PRIMARY KEY AUTOINCREMENT,
                nome  TEXT NOT NULL UNIQUE,
                ativo INTEGER DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS leitos (
                id     INTEGER PRIMARY KEY AUTOINCREMENT,
                uti_id INTEGER NOT NULL,
                numero TEXT NOT NULL,
                ativo  INTEGER DEFAULT 1,
                FOREIGN KEY (uti_id) REFERENCES utis(id),
                UNIQUE(uti_id, numero)
            );

            CREATE TABLE IF NOT EXISTS ocupacoes (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                leito_id        INTEGER NOT NULL,
                nome_paciente   TEXT NOT NULL,
                data_nascimento DATE NOT NULL,
                data_entrada    DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
                data_saida      DATETIME,
                motivo_saida    TEXT,
                ativa           INTEGER DEFAULT 1,
                created_at      DATETIME DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (leito_id) REFERENCES leitos(id)
            );

            CREATE TABLE IF NOT EXISTS checklists (
                id                       INTEGER PRIMARY KEY AUTOINCREMENT,
                ocupacao_id              INTEGER NOT NULL,
                leito_id                 INTEGER NOT NULL,
                data_registro            DATE NOT NULL,
                antibiotico              TEXT NOT NULL,
                dia_antibiotico          INTEGER,
                ventilacao               TEXT NOT NULL,
                dia_ventilacao           INTEGER,
                dispositivo_venoso       TEXT NOT NULL,
                sonda_vesical            TEXT NOT NULL,
                nutricao                 TEXT NOT NULL,
                vasopressor              TEXT NOT NULL,
                sedacao                  TEXT NOT NULL,
                delirium                 TEXT NOT NULL,
                profilaxia_tev           TEXT NOT NULL,
                profilaxia_ue            TEXT NOT NULL,
                mobilizacao              TEXT NOT NULL,
                dispositivos_necessarios TEXT NOT NULL,
                reavaliacao_atb          TEXT,
                dias_vm                  INTEGER,
                dias_cvc                 INTEGER,
                dias_sonda               INTEGER,
                previsao_alta            TEXT,
                profissional             TEXT NOT NULL,
                created_at               DATETIME DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (ocupacao_id) REFERENCES ocupacoes(id),
                FOREIGN KEY (leito_id)   REFERENCES leitos(id),
                UNIQUE(ocupacao_id, data_registro)
            );

            CREATE TABLE IF NOT EXISTS usuarios (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                nome          TEXT NOT NULL,
                email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
                senha_hash    TEXT NOT NULL,
                perfil        TEXT NOT NULL DEFAULT 'usuario',
                status        TEXT NOT NULL DEFAULT 'pendente',
                created_at    DATETIME DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS tokens_aprovacao (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                usuario_id  INTEGER NOT NULL,
                token       TEXT NOT NULL UNIQUE,
                acao        TEXT NOT NULL,
                usado       INTEGER DEFAULT 0,
                expira_em   DATETIME NOT NULL,
                created_at  DATETIME DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
            );
        """)

        # Seed UTIs + leitos
        config = [('UTI 1', 8), ('UTI 2', 10), ('UTI 3', 10)]
        for nome, n in config:
            row = conn.execute('SELECT id FROM utis WHERE nome=?', (nome,)).fetchone()
            if not row:
                cur = conn.execute('INSERT INTO utis (nome) VALUES (?)', (nome,))
                uti_id = cur.lastrowid
                for i in range(1, n + 1):
                    conn.execute('INSERT INTO leitos (uti_id, numero) VALUES (?,?)',
                                 (uti_id, f'{i:02d}'))

        # Seed admin user
        admin = conn.execute('SELECT id FROM usuarios WHERE email=?', (ADMIN_EMAIL,)).fetchone()
        if not admin:
            conn.execute(
                'INSERT INTO usuarios (nome, email, senha_hash, perfil, status) VALUES (?,?,?,?,?)',
                ('Administrador', ADMIN_EMAIL,
                 generate_password_hash('Kamila@221093'), 'admin', 'aprovado')
            )

def rows_to_list(rows): return [dict(r) for r in rows]
def row_to_dict(row):   return dict(row) if row else None

# ─────────────────────────────────────────────
#  AUTH MIDDLEWARE
# ─────────────────────────────────────────────

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        uid = session.get('user_id')
        if not uid:
            return jsonify({'error': 'Autenticacao necessaria', 'auth_required': True}), 401
        with get_db() as conn:
            user = conn.execute('SELECT id, perfil, status FROM usuarios WHERE id=?', (uid,)).fetchone()
        if not user or user['status'] != 'aprovado':
            session.clear()
            return jsonify({'error': 'Acesso negado', 'auth_required': True}), 403
        request.current_user = dict(user)
        return f(*args, **kwargs)
    return decorated

def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        uid = session.get('user_id')
        if not uid:
            return jsonify({'error': 'Autenticacao necessaria', 'auth_required': True}), 401
        with get_db() as conn:
            user = conn.execute('SELECT id, perfil, status FROM usuarios WHERE id=?', (uid,)).fetchone()
        if not user or user['status'] != 'aprovado' or user['perfil'] != 'admin':
            return jsonify({'error': 'Acesso restrito ao administrador'}), 403
        request.current_user = dict(user)
        return f(*args, **kwargs)
    return decorated

# ─────────────────────────────────────────────
#  EMAIL SERVICE
# ─────────────────────────────────────────────

def send_email_async(to, subject, html_body):
    """Send email in background thread. Fails silently if SMTP not configured."""
    if not SMTP_USER or not SMTP_PASS:
        print(f"[EMAIL] SMTP nao configurado. Email para {to} nao enviado.")
        print(f"[EMAIL] Assunto: {subject}")
        return

    def _send():
        try:
            msg = MIMEMultipart('alternative')
            msg['Subject'] = subject
            msg['From'] = f'Monitor NEXO <{SMTP_USER}>'
            msg['To'] = to
            msg.attach(MIMEText(html_body, 'html', 'utf-8'))

            with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
                server.starttls()
                server.login(SMTP_USER, SMTP_PASS)
                server.sendmail(SMTP_USER, to, msg.as_string())
            print(f"[EMAIL] Enviado para {to}")
        except Exception as e:
            print(f"[EMAIL] Erro ao enviar para {to}: {e}")

    threading.Thread(target=_send, daemon=True).start()

def send_approval_email(user_nome, user_email, user_id):
    """Send admin notification with approve/reject links."""
    with get_db() as conn:
        # Generate approve token
        approve_token = secrets.token_urlsafe(48)
        reject_token = secrets.token_urlsafe(48)
        expira = (datetime.now() + timedelta(days=7)).strftime('%Y-%m-%d %H:%M:%S')

        conn.execute(
            'INSERT INTO tokens_aprovacao (usuario_id, token, acao, expira_em) VALUES (?,?,?,?)',
            (user_id, approve_token, 'aprovar', expira)
        )
        conn.execute(
            'INSERT INTO tokens_aprovacao (usuario_id, token, acao, expira_em) VALUES (?,?,?,?)',
            (user_id, reject_token, 'recusar', expira)
        )

    approve_url = f"{APP_URL}/auth/aprovar/{approve_token}"
    reject_url  = f"{APP_URL}/auth/aprovar/{reject_token}"
    data_str    = datetime.now().strftime('%d/%m/%Y %H:%M')

    html = f"""
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;background:#f5f7fa;padding:30px">
      <div style="background:#1E3A8A;color:#fff;padding:24px 30px;border-radius:12px 12px 0 0;text-align:center">
        <h1 style="margin:0;font-size:22px;font-weight:800">Monitor NEXO</h1>
        <p style="margin:4px 0 0;font-size:13px;opacity:.8">Plataforma de Monitoramento Assistencial</p>
      </div>
      <div style="background:#fff;padding:28px 30px;border-radius:0 0 12px 12px;border:1px solid #e2e8f0;border-top:none">
        <h2 style="color:#1E3A8A;font-size:18px;margin:0 0 16px">Novo cadastro pendente</h2>
        <table style="width:100%;font-size:14px;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#64748b;width:130px">Nome:</td><td style="padding:8px 0;font-weight:600">{user_nome}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b">Email:</td><td style="padding:8px 0;font-weight:600">{user_email}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b">Data:</td><td style="padding:8px 0;font-weight:600">{data_str}</td></tr>
        </table>
        <div style="margin:24px 0;text-align:center">
          <a href="{approve_url}" style="display:inline-block;background:#16A34A;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;margin-right:12px">Aprovar conta</a>
          <a href="{reject_url}" style="display:inline-block;background:#DC2626;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Recusar</a>
        </div>
        <p style="font-size:12px;color:#94a3b8;text-align:center;margin:16px 0 0">Links validos por 7 dias.</p>
      </div>
    </div>
    """
    send_email_async(ADMIN_EMAIL, f'[Monitor NEXO] Novo cadastro: {user_nome}', html)

# ─────────────────────────────────────────────
#  STATIC
# ─────────────────────────────────────────────

@app.route('/')
def index(): return send_from_directory(PUB_DIR, 'index.html')

@app.route('/css/<path:f>')
def css(f): return send_from_directory(os.path.join(PUB_DIR, 'css'), f)

@app.route('/js/<path:f>')
def js(f):  return send_from_directory(os.path.join(PUB_DIR, 'js'),  f)

# ─────────────────────────────────────────────
#  AUTH ROUTES
# ─────────────────────────────────────────────

@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    d = request.get_json()
    email = (d.get('email') or '').strip().lower()
    senha = d.get('senha') or ''

    if not email or not senha:
        return jsonify({'error': 'Email e senha sao obrigatorios'}), 400

    with get_db() as conn:
        user = conn.execute('SELECT * FROM usuarios WHERE email=?', (email,)).fetchone()

    if not user or not check_password_hash(user['senha_hash'], senha):
        return jsonify({'error': 'Usuario ou senha invalidos.'}), 401

    if user['status'] == 'pendente':
        return jsonify({'error': 'Sua conta ainda esta aguardando aprovacao do administrador.'}), 403
    if user['status'] == 'recusado':
        return jsonify({'error': 'Sua conta foi recusada pelo administrador.'}), 403

    session.permanent = True
    session['user_id'] = user['id']

    return jsonify({
        'user': {
            'id': user['id'],
            'nome': user['nome'],
            'email': user['email'],
            'perfil': user['perfil']
        }
    })

@app.route('/api/auth/register', methods=['POST'])
def auth_register():
    d = request.get_json()
    nome  = (d.get('nome') or '').strip()
    email = (d.get('email') or '').strip().lower()
    senha = d.get('senha') or ''

    if not nome or not email or not senha:
        return jsonify({'error': 'Todos os campos sao obrigatorios'}), 400

    if len(nome) < 3:
        return jsonify({'error': 'Nome deve ter pelo menos 3 caracteres'}), 400

    import re
    if not re.match(r'^[^@\s]+@[^@\s]+\.[^@\s]+$', email):
        return jsonify({'error': 'Formato de email invalido'}), 400

    if len(senha) < 8:
        return jsonify({'error': 'Senha deve ter pelo menos 8 caracteres'}), 400

    with get_db() as conn:
        existing = conn.execute('SELECT id FROM usuarios WHERE email=?', (email,)).fetchone()
        if existing:
            return jsonify({'error': 'Ja existe uma conta com este email'}), 409

        cur = conn.execute(
            'INSERT INTO usuarios (nome, email, senha_hash, perfil, status) VALUES (?,?,?,?,?)',
            (nome, email, generate_password_hash(senha), 'usuario', 'pendente')
        )
        user_id = cur.lastrowid

    # Notify admin
    send_approval_email(nome, email, user_id)

    return jsonify({
        'message': 'Cadastro enviado com sucesso. Sua conta sera liberada apos aprovacao do administrador.'
    })

@app.route('/api/auth/me', methods=['GET'])
def auth_me():
    uid = session.get('user_id')
    if not uid:
        return jsonify({'user': None})

    with get_db() as conn:
        user = conn.execute(
            'SELECT id, nome, email, perfil, status FROM usuarios WHERE id=?', (uid,)
        ).fetchone()

    if not user or user['status'] != 'aprovado':
        session.clear()
        return jsonify({'user': None})

    return jsonify({
        'user': {
            'id': user['id'],
            'nome': user['nome'],
            'email': user['email'],
            'perfil': user['perfil']
        }
    })

@app.route('/api/auth/logout', methods=['POST'])
def auth_logout():
    session.clear()
    return jsonify({'message': 'Logout realizado'})

# ─── Email approval link handler ────────────
@app.route('/auth/aprovar/<token>')
def aprovar_por_token(token):
    with get_db() as conn:
        tk = conn.execute(
            'SELECT * FROM tokens_aprovacao WHERE token=? AND usado=0', (token,)
        ).fetchone()

        if not tk:
            return _approval_page('Link invalido ou ja utilizado.', 'error')

        if datetime.now() > datetime.strptime(tk['expira_em'], '%Y-%m-%d %H:%M:%S'):
            return _approval_page('Este link expirou.', 'error')

        user = conn.execute('SELECT * FROM usuarios WHERE id=?', (tk['usuario_id'],)).fetchone()
        if not user:
            return _approval_page('Usuario nao encontrado.', 'error')

        acao = tk['acao']
        new_status = 'aprovado' if acao == 'aprovar' else 'recusado'

        conn.execute('UPDATE usuarios SET status=? WHERE id=?', (new_status, tk['usuario_id']))
        conn.execute('UPDATE tokens_aprovacao SET usado=1 WHERE usuario_id=?', (tk['usuario_id'],))

    if acao == 'aprovar':
        msg = f'Conta de <strong>{user["nome"]}</strong> ({user["email"]}) aprovada com sucesso.'
        status = 'success'
    else:
        msg = f'Conta de <strong>{user["nome"]}</strong> ({user["email"]}) foi recusada.'
        status = 'warning'

    return _approval_page(msg, status)

def _approval_page(message, status):
    colors = {'success': '#16A34A', 'error': '#DC2626', 'warning': '#D97706'}
    icons  = {'success': '&#x2713;', 'error': '&#x2717;', 'warning': '&#x26A0;'}
    color  = colors.get(status, '#64748B')
    icon   = icons.get(status, '')
    return f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Monitor NEXO</title>
<style>
  body {{ font-family:'Inter','Segoe UI',sans-serif; background:#F5F7FA; display:flex;
         align-items:center; justify-content:center; min-height:100vh; margin:0; }}
  .card {{ background:#fff; border-radius:16px; padding:48px 40px; text-align:center;
           max-width:440px; box-shadow:0 4px 16px rgba(15,23,42,.08); }}
  .icon {{ font-size:48px; color:{color}; margin-bottom:16px; display:block; }}
  h2 {{ color:#0F172A; font-size:1.2rem; margin:0 0 12px; }}
  p {{ color:#64748B; font-size:.9rem; line-height:1.6; margin:0; }}
  a {{ display:inline-block; margin-top:24px; padding:10px 28px; background:#1E3A8A;
       color:#fff; text-decoration:none; border-radius:8px; font-weight:600; font-size:.875rem; }}
  a:hover {{ background:#3B82F6; }}
</style></head><body>
<div class="card">
  <span class="icon">{icon}</span>
  <h2>Monitor NEXO</h2>
  <p>{message}</p>
  <a href="/">Ir para o sistema</a>
</div></body></html>""", 200

# ─────────────────────────────────────────────
#  ADMIN — USER MANAGEMENT
# ─────────────────────────────────────────────

@app.route('/api/admin/usuarios', methods=['GET'])
@admin_required
def admin_listar_usuarios():
    status_filter = request.args.get('status')
    sql = 'SELECT id, nome, email, perfil, status, created_at FROM usuarios WHERE 1=1'
    params = []
    if status_filter:
        sql += ' AND status=?'
        params.append(status_filter)
    sql += ' ORDER BY created_at DESC'
    with get_db() as conn:
        rows = conn.execute(sql, params).fetchall()
    return jsonify(rows_to_list(rows))

@app.route('/api/admin/usuarios/<int:uid>/aprovar', methods=['POST'])
@admin_required
def admin_aprovar_usuario(uid):
    with get_db() as conn:
        user = conn.execute('SELECT id, status FROM usuarios WHERE id=?', (uid,)).fetchone()
        if not user:
            return jsonify({'error': 'Usuario nao encontrado'}), 404
        conn.execute('UPDATE usuarios SET status=? WHERE id=?', ('aprovado', uid))
    return jsonify({'message': 'Usuario aprovado com sucesso'})

@app.route('/api/admin/usuarios/<int:uid>/recusar', methods=['POST'])
@admin_required
def admin_recusar_usuario(uid):
    with get_db() as conn:
        user = conn.execute('SELECT id, status FROM usuarios WHERE id=?', (uid,)).fetchone()
        if not user:
            return jsonify({'error': 'Usuario nao encontrado'}), 404
        conn.execute('UPDATE usuarios SET status=? WHERE id=?', ('recusado', uid))
    return jsonify({'message': 'Usuario recusado'})

@app.route('/api/admin/usuarios/<int:uid>', methods=['DELETE'])
@admin_required
def admin_excluir_usuario(uid):
    if uid == session.get('user_id'):
        return jsonify({'error': 'Voce nao pode excluir sua propria conta'}), 400
    with get_db() as conn:
        conn.execute('DELETE FROM tokens_aprovacao WHERE usuario_id=?', (uid,))
        conn.execute('DELETE FROM usuarios WHERE id=?', (uid,))
    return jsonify({'message': 'Usuario excluido'})

# ─────────────────────────────────────────────
#  UTIs (protected)
# ─────────────────────────────────────────────

@app.route('/api/utis', methods=['GET'])
@login_required
def listar_utis():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT u.id, u.nome,
              COUNT(l.id)                                          AS total_leitos,
              SUM(CASE WHEN o.ativa=1 THEN 1 ELSE 0 END)          AS ocupados,
              COUNT(l.id)-SUM(CASE WHEN o.ativa=1 THEN 1 ELSE 0 END) AS vagos
            FROM utis u
            JOIN leitos l ON l.uti_id=u.id AND l.ativo=1
            LEFT JOIN ocupacoes o ON o.leito_id=l.id AND o.ativa=1
            WHERE u.ativo=1
            GROUP BY u.id, u.nome ORDER BY u.id
        """).fetchall()
    return jsonify(rows_to_list(rows))

# ─────────────────────────────────────────────
#  LEITOS (protected)
# ─────────────────────────────────────────────

@app.route('/api/utis/<int:uti_id>/leitos', methods=['GET'])
@login_required
def leitos_da_uti(uti_id):
    with get_db() as conn:
        rows = conn.execute("""
            SELECT
              l.id, l.numero, l.uti_id,
              o.id             AS ocupacao_id,
              o.nome_paciente,
              o.data_nascimento,
              o.data_entrada,
              CASE WHEN o.id IS NOT NULL THEN 1 ELSE 0 END AS ocupado
            FROM leitos l
            LEFT JOIN ocupacoes o ON o.leito_id=l.id AND o.ativa=1
            WHERE l.uti_id=? AND l.ativo=1
            ORDER BY CAST(l.numero AS INTEGER)
        """, (uti_id,)).fetchall()
    return jsonify(rows_to_list(rows))

# ─────────────────────────────────────────────
#  OCUPACOES (protected)
# ─────────────────────────────────────────────

@app.route('/api/ocupacoes/<int:oid>', methods=['GET'])
@login_required
def get_ocupacao(oid):
    with get_db() as conn:
        row = conn.execute("""
            SELECT o.*, l.numero AS leito_numero, l.uti_id,
              u.nome AS uti_nome
            FROM ocupacoes o
            JOIN leitos l ON l.id=o.leito_id
            JOIN utis u ON u.id=l.uti_id
            WHERE o.id=?
        """, (oid,)).fetchone()
    if not row: return jsonify({'error': 'Ocupacao nao encontrada'}), 404
    return jsonify(row_to_dict(row))

@app.route('/api/leitos/<int:leito_id>/internar', methods=['POST'])
@login_required
def internar(leito_id):
    d    = request.get_json()
    nome = (d.get('nome_paciente') or '').strip()
    dob  = d.get('data_nascimento')
    if not nome or not dob:
        return jsonify({'error': 'Nome e data de nascimento sao obrigatorios'}), 400
    with get_db() as conn:
        if conn.execute('SELECT id FROM ocupacoes WHERE leito_id=? AND ativa=1',
                        (leito_id,)).fetchone():
            return jsonify({'error': 'Leito ocupado. Registre a saida primeiro.'}), 409
        cur = conn.execute("""
            INSERT INTO ocupacoes (leito_id, nome_paciente, data_nascimento)
            VALUES (?,?,?)
        """, (leito_id, nome, dob))
    return jsonify({'id': cur.lastrowid, 'message': 'Paciente internado com sucesso'})

@app.route('/api/ocupacoes/<int:oid>/saida', methods=['POST'])
@login_required
def dar_saida(oid):
    d      = request.get_json()
    motivo = d.get('motivo_saida')
    if motivo not in ('alta', 'obito'):
        return jsonify({'error': 'Motivo deve ser "alta" ou "obito"'}), 400
    with get_db() as conn:
        occ = conn.execute('SELECT id, ativa FROM ocupacoes WHERE id=?', (oid,)).fetchone()
        if not occ:    return jsonify({'error': 'Ocupacao nao encontrada'}), 404
        if not occ['ativa']: return jsonify({'error': 'Ocupacao ja encerrada'}), 400
        conn.execute("""
            UPDATE ocupacoes SET ativa=0,
              data_saida=datetime('now','localtime'), motivo_saida=?
            WHERE id=?
        """, (motivo, oid))
    return jsonify({'message': 'Saida registrada com sucesso'})

@app.route('/api/historico', methods=['GET'])
@login_required
def historico():
    uti_id  = request.args.get('uti_id')
    leito_n = request.args.get('leito_numero')
    di      = request.args.get('data_inicio')
    df      = request.args.get('data_fim')
    motivo  = request.args.get('motivo_saida')

    sql    = """
        SELECT o.id, o.nome_paciente, o.data_nascimento,
          o.data_entrada, o.data_saida, o.motivo_saida, o.ativa,
          l.numero AS leito_numero, l.id AS leito_id,
          u.nome AS uti_nome, u.id AS uti_id
        FROM ocupacoes o
        JOIN leitos l ON l.id=o.leito_id
        JOIN utis u ON u.id=l.uti_id
        WHERE 1=1
    """
    params = []
    if uti_id:  sql += ' AND u.id=?';                   params.append(int(uti_id))
    if leito_n: sql += ' AND l.numero=?';               params.append(leito_n)
    if di:      sql += ' AND date(o.data_entrada)>=?';  params.append(di)
    if df:      sql += ' AND date(o.data_entrada)<=?';  params.append(df)
    if motivo:  sql += ' AND o.motivo_saida=?';         params.append(motivo)
    sql += ' ORDER BY o.data_entrada DESC'

    with get_db() as conn:
        rows = conn.execute(sql, params).fetchall()
    return jsonify(rows_to_list(rows))

# ─────────────────────────────────────────────
#  CHECKLISTS (protected)
# ─────────────────────────────────────────────

@app.route('/api/checklists/ocupacao/<int:oid>', methods=['GET'])
@login_required
def checklists_da_ocupacao(oid):
    with get_db() as conn:
        rows = conn.execute(
            'SELECT * FROM checklists WHERE ocupacao_id=? ORDER BY data_registro DESC', (oid,)
        ).fetchall()
    return jsonify(rows_to_list(rows))

@app.route('/api/checklists/ocupacao/<int:oid>/data/<data>', methods=['GET'])
@login_required
def checklist_por_data(oid, data):
    with get_db() as conn:
        row = conn.execute(
            'SELECT * FROM checklists WHERE ocupacao_id=? AND data_registro=?', (oid, data)
        ).fetchone()
    return jsonify(row_to_dict(row))

@app.route('/api/checklists', methods=['POST'])
@login_required
def salvar_checklist():
    d    = request.get_json()
    oid  = d.get('ocupacao_id')
    lid  = d.get('leito_id')
    dr   = d.get('data_registro')
    prof = (d.get('profissional') or '').strip()
    if not all([oid, lid, dr, prof]):
        return jsonify({'error': 'Campos obrigatorios faltando'}), 400

    fields = (
        d.get('antibiotico'),    d.get('dia_antibiotico') or None,
        d.get('ventilacao'),     d.get('dia_ventilacao')  or None,
        d.get('dispositivo_venoso'), d.get('sonda_vesical'),
        d.get('nutricao'),       d.get('vasopressor'),
        d.get('sedacao'),        d.get('delirium'),
        d.get('profilaxia_tev'), d.get('profilaxia_ue'),
        d.get('mobilizacao'),    d.get('dispositivos_necessarios'),
        d.get('reavaliacao_atb') or None,
        d.get('dias_vm') or None, d.get('dias_cvc') or None, d.get('dias_sonda') or None,
        d.get('previsao_alta') or None,
        prof
    )

    with get_db() as conn:
        if not conn.execute('SELECT id FROM ocupacoes WHERE id=?', (oid,)).fetchone():
            return jsonify({'error': 'Internacao nao encontrada'}), 404

        existing = conn.execute(
            'SELECT id FROM checklists WHERE ocupacao_id=? AND data_registro=?', (oid, dr)
        ).fetchone()

        if existing:
            conn.execute("""
                UPDATE checklists SET
                  antibiotico=?, dia_antibiotico=?, ventilacao=?, dia_ventilacao=?,
                  dispositivo_venoso=?, sonda_vesical=?, nutricao=?, vasopressor=?,
                  sedacao=?, delirium=?, profilaxia_tev=?, profilaxia_ue=?,
                  mobilizacao=?, dispositivos_necessarios=?,
                  reavaliacao_atb=?, dias_vm=?, dias_cvc=?, dias_sonda=?,
                  previsao_alta=?, profissional=?
                WHERE id=?
            """, fields + (existing['id'],))
            return jsonify({'id': existing['id'], 'message': 'Checklist atualizado'})
        else:
            cur = conn.execute("""
                INSERT INTO checklists (
                  ocupacao_id, leito_id, data_registro,
                  antibiotico, dia_antibiotico, ventilacao, dia_ventilacao,
                  dispositivo_venoso, sonda_vesical, nutricao, vasopressor,
                  sedacao, delirium, profilaxia_tev, profilaxia_ue,
                  mobilizacao, dispositivos_necessarios,
                  reavaliacao_atb, dias_vm, dias_cvc, dias_sonda,
                  previsao_alta, profissional
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (oid, lid, dr) + fields)
            return jsonify({'id': cur.lastrowid, 'message': 'Checklist salvo'})

# ─────────────────────────────────────────────
#  DASHBOARD (protected)
# ─────────────────────────────────────────────

@app.route('/api/dashboard', methods=['GET'])
@login_required
def dashboard():
    hoje   = date.today().isoformat()
    uti_id = request.args.get('uti_id')
    default_inicio = (date.today() - timedelta(days=29)).isoformat()
    inicio = request.args.get('data_inicio') or default_inicio
    fim    = request.args.get('data_fim') or hoje

    uf  = ' AND l.uti_id=?' if uti_id else ''
    up  = [int(uti_id)] if uti_id else []

    with get_db() as conn:
        occ_stats = rows_to_list(conn.execute("""
            SELECT u.id, u.nome,
              COUNT(l.id) AS total,
              SUM(CASE WHEN o.ativa=1 THEN 1 ELSE 0 END) AS ocupados,
              COUNT(l.id)-SUM(CASE WHEN o.ativa=1 THEN 1 ELSE 0 END) AS vagos
            FROM utis u
            JOIN leitos l ON l.uti_id=u.id AND l.ativo=1
            LEFT JOIN ocupacoes o ON o.leito_id=l.id AND o.ativa=1
            WHERE u.ativo=1 GROUP BY u.id ORDER BY u.id
        """).fetchall())

        total_pac = conn.execute(
            f'SELECT COUNT(*) FROM ocupacoes o JOIN leitos l ON l.id=o.leito_id WHERE o.ativa=1{uf}',
            up).fetchone()[0]

        hs = conn.execute(f"""
            SELECT COUNT(*) AS total,
              SUM(CASE WHEN ventilacao='vmi' THEN 1 ELSE 0 END)   AS ventilados_vmi,
              SUM(CASE WHEN antibiotico='sim' THEN 1 ELSE 0 END)   AS uso_atb,
              SUM(CASE WHEN dispositivo_venoso IN ('cvc','picc') THEN 1 ELSE 0 END) AS uso_dvc,
              SUM(CASE WHEN sonda_vesical='sim' THEN 1 ELSE 0 END) AS uso_svd,
              SUM(CASE WHEN vasopressor='sim' THEN 1 ELSE 0 END)   AS uso_vaso,
              SUM(CASE WHEN delirium='positivo' THEN 1 ELSE 0 END) AS delirium_pos,
              SUM(CASE WHEN mobilizacao IN ('sedestacao','ortostatismo','deambulacao') THEN 1 ELSE 0 END) AS mobilizados,
              SUM(CASE WHEN profilaxia_tev IN ('farmacologica','mecanica') THEN 1 ELSE 0 END) AS prof_tev_ok,
              AVG(CASE WHEN ventilacao='vmi' AND dia_ventilacao IS NOT NULL THEN CAST(dia_ventilacao AS REAL) END) AS media_dias_vm,
              AVG(CASE WHEN antibiotico='sim' AND dia_antibiotico IS NOT NULL THEN CAST(dia_antibiotico AS REAL) END) AS media_dias_atb
            FROM checklists c JOIN leitos l ON l.id=c.leito_id
            WHERE c.data_registro BETWEEN ? AND ?{uf}
        """, [inicio, fim] + up).fetchone()
        hoje_stats = row_to_dict(hs) or {}

        checklist_hoje = conn.execute(
            f'SELECT COUNT(*) FROM checklists c JOIN leitos l ON l.id=c.leito_id WHERE c.data_registro=?{uf}',
            [hoje] + up).fetchone()[0]

        avg_row = conn.execute(f"""
            SELECT AVG(CAST(
              COALESCE(julianday(o.data_saida), julianday('now')) - julianday(o.data_entrada)
            AS REAL)) AS v
            FROM ocupacoes o JOIN leitos l ON l.id=o.leito_id
            WHERE date(o.data_entrada) BETWEEN ? AND ?{uf}
        """, [inicio, fim] + up).fetchone()
        avg_los = round(avg_row['v'], 1) if avg_row and avg_row['v'] else 0

        uf2 = f' AND l2.uti_id={int(uti_id)}' if uti_id else ''
        trends = rows_to_list(conn.execute(f"""
            SELECT c.data_registro,
              COUNT(*) AS total,
              SUM(CASE WHEN ventilacao='vmi' THEN 1 ELSE 0 END) AS vmi,
              SUM(CASE WHEN antibiotico='sim' THEN 1 ELSE 0 END) AS atb,
              SUM(CASE WHEN delirium='positivo' THEN 1 ELSE 0 END) AS delirium,
              SUM(CASE WHEN mobilizacao IN ('sedestacao','ortostatismo','deambulacao') THEN 1 ELSE 0 END) AS mobilizados,
              SUM(CASE WHEN vasopressor='sim' THEN 1 ELSE 0 END) AS vasopressor,
              SUM(CASE WHEN sonda_vesical='sim' THEN 1 ELSE 0 END) AS svd,
              SUM(CASE WHEN dispositivo_venoso IN ('cvc','picc') THEN 1 ELSE 0 END) AS dvc,
              (SELECT COUNT(*) FROM ocupacoes o2
               JOIN leitos l2 ON l2.id=o2.leito_id
               WHERE date(o2.data_entrada) <= c.data_registro
               AND (o2.data_saida IS NULL OR date(o2.data_saida) >= c.data_registro){uf2}
              ) AS ativos_no_dia
            FROM checklists c JOIN leitos l ON l.id=c.leito_id
            WHERE c.data_registro BETWEEN ? AND ?{uf}
            GROUP BY c.data_registro ORDER BY c.data_registro
        """, [inicio, fim] + up).fetchall())

    return jsonify({
        'totalPacientes': total_pac,
        'checklist_count_hoje': checklist_hoje,
        'checklist_count_periodo': hoje_stats.get('total') or 0,
        'hoje_stats': hoje_stats,
        'avg_los': avg_los,
        'trends': trends,
        'occ_stats': occ_stats,
        'periodo': {'inicio': inicio, 'fim': fim}
    })

# ─────────────────────────────────────────────
#  EXPORTACAO CSV (protected)
# ─────────────────────────────────────────────

@app.route('/api/export/csv', methods=['GET'])
@login_required
def export_csv():
    uti_id = request.args.get('uti_id')
    di     = request.args.get('data_inicio')
    df     = request.args.get('data_fim')

    sql = """
        SELECT u.nome AS uti, l.numero AS leito,
          o.nome_paciente, o.data_nascimento,
          c.data_registro,
          c.antibiotico, c.dia_antibiotico, c.ventilacao, c.dia_ventilacao,
          c.dispositivo_venoso, c.sonda_vesical, c.nutricao,
          c.vasopressor, c.sedacao, c.delirium,
          c.profilaxia_tev, c.profilaxia_ue, c.mobilizacao,
          c.dispositivos_necessarios,
          c.reavaliacao_atb, c.dias_vm, c.dias_cvc, c.dias_sonda,
          c.previsao_alta, c.profissional
        FROM checklists c
        JOIN ocupacoes o ON o.id=c.ocupacao_id
        JOIN leitos l ON l.id=c.leito_id
        JOIN utis u ON u.id=l.uti_id WHERE 1=1
    """
    params = []
    if uti_id: sql += ' AND u.id=?';                params.append(int(uti_id))
    if di:     sql += ' AND c.data_registro>=?';     params.append(di)
    if df:     sql += ' AND c.data_registro<=?';     params.append(df)
    sql += ' ORDER BY c.data_registro DESC, u.id, CAST(l.numero AS INTEGER)'

    with get_db() as conn:
        rows = conn.execute(sql, params).fetchall()
    if not rows: return jsonify({'error': 'Nenhum dado encontrado'}), 404

    out = io.StringIO()
    w   = csv.writer(out, delimiter=';', quoting=csv.QUOTE_ALL)
    w.writerow(rows[0].keys())
    for r in rows: w.writerow([v if v is not None else '' for v in r])

    return Response('\ufeff' + out.getvalue(), mimetype='text/csv; charset=utf-8',
        headers={'Content-Disposition': 'attachment; filename="UTI_checklists.csv"'})

# ─────────────────────────────────────────────
#  START
# ─────────────────────────────────────────────

if __name__ == '__main__':
    init_db()
    print("\n[OK] Monitor NEXO rodando em http://localhost:3000\n")
    app.run(host='0.0.0.0', port=3000, debug=False)
