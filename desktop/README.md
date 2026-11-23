# Kortes Desktop para Windows

O mesmo Kortes do servidor (`KORTES_EDITION=desktop`), empacotado como um programa
que roda inteiro no PC do cliente, sem Docker.

## Como o programa funciona

```
KortesSetup.exe  →  C:\Program Files\Kortes\            (substituído a cada atualização)
                     ├─ Kortes.exe                       janela (Electron) + gerente dos serviços
                     └─ resources\
                        ├─ app\frontend\                 Next.js já compilado (roda no Node do Electron)
                        ├─ app\backend\src\              código Python do backend
                        ├─ python\                       Python 3.12 com todas as dependências
                        ├─ postgres\  redis\  ffmpeg\    binários portáteis
                        └─ fonts\  transitions\

                  →  %LOCALAPPDATA%\Kortes\              (do cliente; NUNCA tocado por atualizações)
                     ├─ postgres\                        banco (tarefas, clipes, licença criptografada)
                     ├─ media\                           vídeos baixados e clipes prontos
                     ├─ models\                          modelo do Whisper (baixado no primeiro uso)
                     └─ logs\
```

Ao abrir, o `Kortes.exe`:
1. sobe o Postgres e o Redis em portas livres, só para o próprio PC (127.0.0.1);
2. sobe o backend (API), o worker (análise e montagem) e o frontend;
3. espera tudo responder e abre a janela do Kortes;
4. ao fechar a janela, desliga tudo na ordem certa.

O ID do computador vem do Windows (`MachineGuid`) e vai em hash para o servidor de
licenças, então reinstalar o programa não gasta outro computador da licença.

## Atualizações

**Para você (publicar uma versão):**
1. muda o código no branch `desktop` (ou traz melhorias da web com `git merge main`);
2. sobe a versão no `desktop/package.json` (ex.: `1.4.0`) e cria a tag `desktop-v1.4.0`;
3. o GitHub Actions compila no Windows e publica o instalador e o `latest.yml` nos Releases.

**Para o cliente (sem fazer nada):**
1. ao abrir o Kortes, e depois a cada poucas horas, o programa confere se há versão nova;
2. se houver, baixa em segundo plano só as partes que mudaram (atualização diferencial);
3. mostra "Atualização pronta" com o botão **Reiniciar agora**. Se ele não clicar, a versão
   nova entra sozinha na próxima vez que ele fechar o programa;
4. vídeos, clipes, licença e configurações ficam intactos, porque moram em
   `%LOCALAPPDATA%\Kortes`, fora da pasta do programa.

**Mudanças no banco:** o backend aplica as migrações (`backend/src/migrations/sql`) ao
iniciar, então uma versão que muda tabelas atualiza o banco do cliente na primeira abertura.

**O que muda sem atualizar o programa:** tudo que fica no servidor (licenças, cotas,
bloqueios, o modelo de IA por trás de `kortes`) muda na hora para todos os clientes.
O que fica no programa (prompts da IA, montagem, telas) só muda com uma versão nova.

**Versão mínima:** o servidor de licenças pode exigir uma versão mínima; um cliente
desatualizado vê "Atualize o Kortes" em vez de erros.

**Desfazer uma versão ruim:** publique outra versão com a correção (ex.: 1.4.1). As
atualizações só andam para frente.

## Placa de vídeo

Com NVIDIA, a montagem usa o encoder da placa (NVENC) e o Whisper roda na GPU. O pacote
para GPU é grande (~2 GB), então ele é baixado à parte, só nos PCs que têm a placa.
