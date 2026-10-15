# Pátio Push na nuvem — guia "clicar e seguir"

**Objetivo:** colocar o sistema na internet com um **endereço fixo e seguro (HTTPS)**, de graça, **sem instalar nada no computador e sem acionar a TI**. Tudo é feito pelo navegador.

**Tempo:** 30 a 45 minutos na primeira vez.
**Você vai precisar de:** um e-mail, o arquivo `patio-push.zip` e um celular para o teste final.

**Como funciona, em uma frase:** o **GitHub** guarda os arquivos do sistema, o **Render** liga o sistema e dá o endereço, e o **Neon** guarda os dados para que não se percam. As três contas são gratuitas.

```
 Celular do motorista ─┐
 PC da portaria ───────┼──►  RENDER (sistema ligado, endereço https)  ──►  NEON (cópia dos dados, São Paulo)
 Tela da equipe ───────┘            ▲
                                    └── lê os arquivos do GITHUB
```

> **Por que três contas?** No Render gratuito, tudo o que o sistema salva é **apagado** quando ele "dorme" (15 minutos sem uso), reinicia ou é atualizado. O Neon guarda uma cópia dos dados fora do Render, e o sistema a recupera sozinho quando acorda. Sem o Neon, a fila e o histórico somem várias vezes por dia.

---

## Antes de começar

1. Baixe o `patio-push.zip` e **descompacte**: clique com o botão direito → *Extrair tudo*.
2. Abra a pasta `patio-push`. Lá dentro devem aparecer: `public`, `src`, `package.json`, `render.yaml`, `GUIA-NUVEM.md`, entre outros.
3. Separe um **PIN de 6 dígitos ou mais** para a portaria (ex.: `482915`). Não use datas nem `123456`: o sistema vai ficar na internet.

---

## PARTE 1 — GitHub: guardar os arquivos do sistema

1. Acesse **github.com** e clique em **Sign up**. Crie a conta com seu e-mail e confirme o código que chega por e-mail.
2. No canto superior direito, clique em **+** → **New repository**.
3. Preencha:
   - **Repository name:** `patio-push`
   - Marque **Private** (privado).
   - Não marque mais nada.
   - Clique em **Create repository**.
4. Na página que abrir, clique no link **uploading an existing file**.
5. Volte à pasta `patio-push` descompactada, **entre nela**, selecione **tudo o que está dentro** (Ctrl + A) e **arraste** para a área do GitHub no navegador.
   - ⚠ Arraste o **conteúdo** da pasta, não a pasta `patio-push` em si. Caso contrário, o Render não encontra os arquivos.
6. Espere a lista de arquivos carregar e role até o fim da página. Clique em **Commit changes**.
7. ✅ **Conferência:** na página do repositório, `package.json`, `render.yaml`, `src` e `public` aparecem **direto na lista**, sem uma pasta `patio-push` antes.

---

## PARTE 2 — Neon: o "cofre" dos dados

8. Acesse **neon.com** e clique em **Sign up**. Para facilitar, entre com a conta **GitHub** que você acabou de criar. Não pede cartão.
9. Crie o projeto:
   - **Project name:** `patio-push`
   - **Region:** **AWS South America (São Paulo)** (`sa-east-1`) — os dados ficam no Brasil.
   - Deixe o restante como está e clique em **Create project**.
10. No painel do projeto, clique em **Connect** (ou *Connection string*).
11. Copie o endereço que começa com `postgresql://...` (botão **Copy**).
    - Ele inclui uma senha: **não compartilhe** e não cole em grupos. Você vai usá-lo só no passo 17.
    - Pode colar temporariamente num Bloco de Notas.

---

## PARTE 3 — Render: ligar o sistema e ganhar o endereço

12. Acesse **render.com**, clique em **Get Started** e entre com a conta **GitHub**.
13. No painel, clique em **+ New** → **Web Service**.
14. Em *Git Provider*, escolha **GitHub** e autorize o Render. Quando perguntar, escolha **Only select repositories** → `patio-push` → **Install/Authorize**.
15. Na lista, clique em **Connect** ao lado de `patio-push`.
16. Preencha os campos exatamente assim:

| Campo | O que colocar |
|---|---|
| **Name** | um nome curto, ex.: `portaria-brose-cur` (vira o endereço) |
| **Region** | **Virginia (US East)** — a mais próxima do Brasil |
| **Branch** | `main` |
| **Root Directory** | deixe **vazio** |
| **Language / Runtime** | **Node** |
| **Build Command** | `npm install --omit=dev` |
| **Start Command** | `npm start` |
| **Instance Type** | **Free** |

17. Em **Environment Variables**, clique em **Add Environment Variable** para cada linha:

| Nome (Key) | Valor (Value) |
|---|---|
| `PORTARIA_PIN` | o PIN que você escolheu (6+ dígitos) |
| `DATABASE_URL` | o endereço `postgresql://...` copiado no passo 11 |
| `NODE_VERSION` | `22` |
| `SITE_NAME` | *(opcional)* ex.: `Portaria Brose Curitiba` |

18. *(Opcional, recomendado)* Abra **Advanced** e preencha **Health Check Path** com `/health`.
19. Clique em **Deploy Web Service**.
20. Aguarde de 3 a 5 minutos. A tela mostra o andamento (*Logs*). O status muda para **Live** (verde).
21. ✅ **Conferência nos Logs** — estas linhas precisam aparecer:
    - `✔ Dados com cópia no banco externo (DATABASE_URL): sobrevivem a reinícios.`
    - `Endereço público: https://portaria-brose-cur.onrender.com`

    Se aparecer `⚠ SEM DATABASE_URL` ou `⚠ PORTARIA_PIN não definido`, corrija no menu **Environment** e salve (o Render reinicia sozinho).
22. **Seu endereço fixo** fica no topo da página do serviço, no formato `https://SEU-NOME.onrender.com`. É esse endereço que vai no QR Code. Ele não muda.

---

## PARTE 4 — Colocar para rodar

**Quem faz o quê:**
- **Portaria** (`https://SEU-NOME.onrender.com`): lança a chegada e mostra o **QR Code** para o motorista. Não chama ninguém.
- **Recebimento / Expedição** (`https://SEU-NOME.onrender.com/equipe`): chama o motorista e indica a doca, marca **Encostou na doca**, chama o motorista **de novo com o caminhão na doca** (carga concluída, ir ao caminhão, documentos, mudar de doca) e **libera a saída**.
- **Motorista**: lê o QR, toca em **ATIVAR ALERTAS** e deixa a página aberta até ser liberado.

23. No PC da portaria, abra `https://SEU-NOME.onrender.com`, entre com seu nome e o PIN e salve nos **favoritos**.
24. **QR Code — dois jeitos (os dois funcionam):**
    - **QR individual:** ao clicar em **LANÇAR NA FILA E GERAR QR**, aparece um QR só daquele motorista. Ele lê com a câmera e cai direto na tela dele, sem digitar nada. O botão **QR** na lista mostra de novo.
    - **Cartaz fixo:** clique em **Cartaz QR** → **Imprimir cartaz** e fixe na guarita. O motorista lê e digita a placa e os 4 últimos números do celular.
25. No PC/TV do **Recebimento**, abra `https://SEU-NOME.onrender.com/equipe`, entre com o PIN e toque em **RECEBIMENTO** (o toque libera o som). Faça o mesmo na **Expedição**. Deixe essa tela aberta e com som ligado.
26. **Teste com celular real** (de preferência no pátio, onde o caminhão espera):
    1. Portaria: lance uma chegada de **Recebimento** com o seu celular. A tela do Recebimento pisca: **NOVO CAMINHÃO NA FILA** → **CIENTE**.
    2. Celular: leia o QR individual → **ATIVAR ALERTAS** → **Permitir**.
    3. Recebimento: **CHAMAR MOTORISTA** → escolha a doca. O celular vibra e toca.
    4. Celular: **ESTOU INDO**. A tela do Recebimento pisca: **MOTORISTA A CAMINHO**.
    5. Recebimento: **Encostou na doca** → **CHAMAR MOTORISTA** → **Carga/descarga concluída**. O celular vibra: **RETIRE O CAMINHÃO**.
    6. Celular: **ESTOU INDO** → Recebimento: **Liberar saída**. O celular mostra **SAÍDA LIBERADA**.
    7. Repita com o celular **bloqueado** (testa a notificação) e com um **iPhone**.

---

## Como atualizar o sistema depois

Quando eu te enviar uma versão nova:

1. No GitHub, abra o repositório `patio-push` → **Add file** → **Upload files**.
2. Arraste o conteúdo da pasta nova (os arquivos com o mesmo nome são substituídos) → **Commit changes**.
3. O Render detecta a mudança e atualiza sozinho em poucos minutos. **Os dados continuam**, porque voltam do Neon.

---

## Limitações da camada gratuita (leia antes de usar na operação)

- **O sistema "dorme"** após 15 minutos sem nenhum acesso. Ao acordar, leva **cerca de 1 minuto**, com uma tela de carregamento. Enquanto a tela da portaria ou da equipe estiver **aberta**, ela envia um sinal a cada 4 minutos e o sistema **não dorme**. Mantenha a portaria aberta durante o expediente.
- **750 horas grátis por mês na conta Render.** Um serviço ligado o mês inteiro usa cerca de 744 horas: cabe **um** sistema gratuito por conta. Se as horas acabarem, ele fica fora do ar até o mês seguinte.
- **O Render pode reiniciar o serviço a qualquer momento.** Os dados voltam do Neon, mas quem estiver logado precisa **entrar de novo com o PIN**. Os celulares dos motoristas reconectam sozinhos.
- **A cópia é salva a cada ~4 segundos.** Numa queda brusca, podem se perder só os últimos segundos de alterações.
- **Os dados ficam fora da Brose.** Nomes, celulares e placas dos motoristas ficam no Neon (São Paulo) e passam pelo Render (EUA). Pela LGPD, **confirme com o responsável de dados/compliance** se isso é aceitável, mesmo sem envolver a TI na configuração.
- **Neon gratuito:** projetos **sem nenhum uso por 90 dias** podem ser apagados. Com uso diário, isso não acontece.
- **Segurança:** o painel fica na internet, protegido só pelo PIN. Use 6+ dígitos, não divulgue fora da equipe e troque se alguém sair (menu *Environment* no Render). A página do motorista mostra apenas os dados dele.
- **O que já foi testado:** o ciclo inteiro (dormir com o disco apagado, acordar e restaurar, inclusive após queda brusca) foi testado com um banco Postgres igual ao do Neon. **A primeira implantação no Render e no Neon de verdade é o teste final**: siga o passo 21 com atenção.

---

## Problemas comuns

| O que aparece | O que fazer |
|---|---|
| Deploy falha com `Cannot find module` ou sem `package.json` | Os arquivos foram enviados dentro de uma pasta. Refaça o passo 5 arrastando o **conteúdo** da pasta. |
| Log: `Não foi possível ler a cópia no banco externo` | A `DATABASE_URL` está errada ou incompleta. Copie de novo no Neon (passo 11), cole em **Environment** e salve. O sistema não inicia de propósito, para não apagar os dados. |
| Login diz "Sistema na internet com PIN padrão" | Falta `PORTARIA_PIN` (ou tem menos de 6 dígitos). Ajuste em **Environment**. |
| Faixa vermelha "DADOS TEMPORÁRIOS" na portaria | Falta `DATABASE_URL`. Veja os passos 8 a 11 e 17. |
| Primeira abertura demora ~1 minuto | O sistema estava dormindo. É normal na camada gratuita. |
| Portaria volta sozinha para a tela de login | O Render reiniciou o serviço. Entre de novo com o PIN; a fila continua lá. |
| Celular não vibra | iPhone não vibra por página web. No Android, confira se tocou em **ATIVAR ALERTAS** e se o celular não está no silencioso. |
