/**
 * Monitor NEXO — Supabase Server-Side Client
 * Handles auth verification and admin operations
 * Creates clients lazily to avoid crash when keys are not set
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ahggydulxcjjghxpamjg.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Lazy-initialized clients
let _supabase = null;
let _supabaseAdmin = null;

function getSupabase() {
  if (!_supabase && SUPABASE_ANON_KEY) {
    _supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return _supabase;
}

function getSupabaseAdmin() {
  if (!_supabaseAdmin && SUPABASE_SERVICE_ROLE_KEY) {
    _supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }
  return _supabaseAdmin;
}

// ─── Middleware: Verificar autenticação ──────────────────

async function requireAuth(req, res, next) {
  const sb = getSupabase();
  if (!sb) {
    return res.status(503).json({ error: 'Supabase não configurado. Defina SUPABASE_ANON_KEY.' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de autenticação não fornecido', auth_required: true });
  }

  const token = authHeader.replace('Bearer ', '');

  try {
    const { data: { user }, error } = await sb.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Token inválido ou expirado', auth_required: true });
    }
    req.user = user;
    next();
  } catch (err) {
    console.error('[AUTH]', err);
    return res.status(401).json({ error: 'Erro na verificação do token', auth_required: true });
  }
}

// ─── Middleware: Verificar admin ─────────────────────────

async function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Não autenticado', auth_required: true });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return res.status(503).json({ error: 'Service role não configurado.' });
  }

  try {
    const { data: profile, error } = await admin
      .from('profiles')
      .select('role')
      .eq('id', req.user.id)
      .single();

    if (error || !profile || profile.role !== 'admin') {
      return res.status(403).json({ error: 'Acesso restrito a administradores' });
    }

    req.userRole = 'admin';
    next();
  } catch (err) {
    console.error('[ADMIN]', err);
    return res.status(403).json({ error: 'Erro ao verificar permissões' });
  }
}

module.exports = {
  getSupabase,
  getSupabaseAdmin,
  requireAuth,
  requireAdmin,
  SUPABASE_URL,
  SUPABASE_ANON_KEY
};
