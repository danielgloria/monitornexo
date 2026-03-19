-- ═══════════════════════════════════════════════════════════
-- MONITOR NEXO — Configuração do Supabase
-- Execute este SQL no Supabase Dashboard: SQL Editor
-- ═══════════════════════════════════════════════════════════

-- ─── 1. Tabela profiles ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name  TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice para busca rápida por role
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);

-- ─── 2. Tabela activity_logs ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id              BIGSERIAL PRIMARY KEY,
  action          TEXT NOT NULL,             -- 'account_created', 'account_deleted', 'role_changed', 'login', etc.
  target_user_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  target_email    TEXT,
  performed_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  performed_email TEXT,
  details         JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON public.activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_action ON public.activity_logs(action);

-- ─── 3. Habilitar RLS ───────────────────────────────────
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

-- ─── 4. Políticas RLS: profiles ─────────────────────────

-- Usuários podem ler seu próprio perfil
CREATE POLICY "Users can read own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

-- Usuários podem atualizar seu próprio perfil (exceto role)
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Admins podem ler todos os perfis
CREATE POLICY "Admins can read all profiles"
  ON public.profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Admins podem atualizar qualquer perfil (inclusive role)
CREATE POLICY "Admins can update all profiles"
  ON public.profiles FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Admins podem deletar perfis
CREATE POLICY "Admins can delete profiles"
  ON public.profiles FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Permitir INSERT durante criação (trigger)
CREATE POLICY "Service can insert profiles"
  ON public.profiles FOR INSERT
  WITH CHECK (true);

-- ─── 5. Políticas RLS: activity_logs ────────────────────

-- Apenas admins podem ler logs
CREATE POLICY "Admins can read logs"
  ON public.activity_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Permitir INSERT para qualquer autenticado (o trigger e a API inserem)
CREATE POLICY "Authenticated can insert logs"
  ON public.activity_logs FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- Service role pode inserir (para triggers)
CREATE POLICY "Service can insert logs"
  ON public.activity_logs FOR INSERT
  WITH CHECK (true);

-- ─── 6. Trigger: criar perfil automático ao signup ──────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'user'
  );

  INSERT INTO public.activity_logs (action, target_user_id, target_email, details)
  VALUES (
    'account_created',
    NEW.id,
    NEW.email,
    jsonb_build_object('method', 'signup', 'provider', COALESCE(NEW.raw_app_meta_data->>'provider', 'email'))
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop se existir e recriar
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ─── 7. Trigger: log ao deletar usuário ─────────────────

CREATE OR REPLACE FUNCTION public.handle_user_deleted()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.activity_logs (action, target_user_id, target_email, details)
  VALUES (
    'account_deleted',
    OLD.id,
    OLD.email,
    jsonb_build_object('deleted_at', now())
  );

  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_deleted ON auth.users;
CREATE TRIGGER on_auth_user_deleted
  BEFORE DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_user_deleted();

-- ─── 8. Função para admin deletar usuários ──────────────
-- Usa a API interna do Supabase (service_role via backend)
-- Não precisa de função SQL, será feita via API no server.js

-- ─── 9. Função auxiliar: verificar se é admin ───────────

CREATE OR REPLACE FUNCTION public.is_admin(user_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = user_id AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ─── 10. Promover o primeiro admin ──────────────────────
-- EXECUTE DEPOIS de criar a conta danielvgloria@gmail.com via signup
-- Substitua o UUID pelo ID real do usuário:
--
-- UPDATE public.profiles
-- SET role = 'admin', updated_at = now()
-- WHERE id = (SELECT id FROM auth.users WHERE email = 'danielvgloria@gmail.com');
--
-- INSERT INTO public.activity_logs (action, target_user_id, target_email, details)
-- VALUES (
--   'role_changed',
--   (SELECT id FROM auth.users WHERE email = 'danielvgloria@gmail.com'),
--   'danielvgloria@gmail.com',
--   '{"old_role": "user", "new_role": "admin", "method": "initial_setup"}'
-- );

-- ═══════════════════════════════════════════════════════════
-- FIM DA CONFIGURAÇÃO
-- ═══════════════════════════════════════════════════════════
