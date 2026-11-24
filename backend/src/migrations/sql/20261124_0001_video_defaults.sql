-- Configurações → "Padrões para novos vídeos": cortes por vídeo, exigência da IA,
-- duração, formato, título no início, ganho inicial (and, in Kortes Desktop, the
-- folder that gets a copy of every cut and the Windows notice). Missing keys keep
-- the app's defaults.
ALTER TABLE users ADD COLUMN IF NOT EXISTS video_defaults JSONB NOT NULL DEFAULT '{}'::jsonb;
