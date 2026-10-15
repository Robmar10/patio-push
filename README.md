# PÁTIO PUSH — protótipo (trial) de controle de pátio e chamada gratuita de motoristas

Fluxo: **Portaria lança a chegada** (autorização R-0001 / E-0002) e mostra o **QR Code** → a tela do **Recebimento/Expedição**
pisca → **motorista lê o QR** e fica aguardando no celular → a **equipe chama e indica a doca** → o **celular vibra e toca** →
motorista toca **ESTOU INDO** → equipe marca **Encostou na doca** → pode **chamar de novo na doca** (carga concluída,
ir ao caminhão, documentos, mudar de doca) → **Liberar saída**.

**Sem custo por mensagem** (não usa SMS). Em troca, há duas condições que o SMS não tinha:

1. **O celular do motorista precisa de internet** (dados móveis ou Wi-Fi) durante a espera. Consumo: poucos kB.
2. **Vibração com tela bloqueada** só acontece se o motorista **permitiu notificações**. Com a página aberta na tela,
   vibra e toca sem precisar dessa permissão (depois que ele toca em *ATIVAR ALERTAS*).

> Este é um protótipo para validar o conceito. Foi testado ponta a ponta em navegador com celular emulado
> (cadastro → QR → chamada → vibração → "estou indo"). **Ainda não foi testado em celulares reais** —
> faça o roteiro da seção 4 antes de usar na operação.

## 0. Colocar na nuvem (sem instalar nada)

Para usar de verdade, com endereço fixo e HTTPS, sem instalar programas nem acionar a TI, siga o **GUIA-NUVEM.md**
(GitHub + Render + Neon, todos gratuitos). As seções abaixo são para rodar localmente.

## 1. Como rodar no seu computador

Requisito: **Node.js 22.5 ou superior** (https://nodejs.org).

```
npm install
copy .env.example .env      (Linux/macOS: cp .env.example .env)
npm start
```

- Portaria / dashboard: `http://localhost:3100` — entre com seu nome e o PIN (padrão **1234**; troque em `PORTARIA_PIN` no `.env`).
- Cartaz do QR Code fixo para imprimir: `http://localhost:3100/cartaz`
- Página do motorista: `/m/`

## 2. Por que precisa de HTTPS para testar no celular

Os navegadores dos celulares **só liberam notificação, Web Push e “manter tela ligada” em sites HTTPS**.
Em `http://192.168.x.x` a página abre e recebe a chamada, mas a notificação com tela bloqueada não funciona.

Jeito gratuito e rápido de ter HTTPS (sem conta, para teste):

1. Instale o **cloudflared** (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. Com o sistema rodando, execute: `cloudflared tunnel --url http://localhost:3100`
3. Ele mostra um endereço `https://xxxx.trycloudflare.com`. Coloque em `PUBLIC_URL=` no `.env` e reinicie (`npm start`).
4. Abra a portaria por esse endereço e imprima o cartaz de novo (o QR passa a apontar para o HTTPS).

O endereço do túnel rápido muda a cada execução — serve para teste. Para uso contínuo, use um túnel nomeado
da Cloudflare com domínio da empresa ou hospede em um servidor com HTTPS.

## 3. Operação

**Portaria — nova chegada:** escolha RECEBIMENTO ou EXPEDIÇÃO, preencha motorista, celular, placa, transportadora,
fornecedor/cliente e carga → **AUTORIZAR ENTRADA NA FILA**. Aparece a autorização e um **QR individual**:
o motorista lê esse QR e já cai na tela dele, sem digitar nada.

Alternativa: o motorista lê o **cartaz fixo** e digita a placa + 4 últimos números do celular.

**Motorista:** toca em **ATIVAR ALERTAS** e em **Permitir** notificações. A tela mostra a posição na fila.

**Chamar (tela Recebimento/Expedição, `/equipe`):** **CHAMAR MOTORISTA** → escolha a doca. O aviso diz como a chamada foi entregue:
- *página aberta (vibrando)*: o celular está vibrando e tocando a cada 3,5 s até ele tocar em ESTOU INDO;
- *notificação enviada*: página fechada, mas o celular recebeu a notificação;
- *SEM CONEXÃO*: o celular não está conectado — avise pessoalmente ou ligue (o telefone aparece na janela).

**Tela da equipe (Recebimento / Expedição):** abra `http://endereço:3100/equipe` no PC ou TV da área, entre com o PIN e
escolha a equipe. Quando a portaria **libera** um caminhão daquele tipo, e de novo quando o motorista toca **ESTOU INDO**,
a tela **pisca em tela cheia (cor da equipe/amarelo) e apita a cada 2 s** mostrando doca, placa, transportadora e carga,
até alguém tocar em **CIENTE**. Na portaria aparece "⚠ Recebimento ainda não viu" ou "✔ Recebimento ciente 17:58".
Cada equipe só recebe alertas dos caminhões dela. O primeiro toque na tela (escolher a equipe) é o que libera o som do navegador.

**Depois (na tela da equipe):** "Estou indo" aparece sozinho e a tela pisca. **Rechamar** repete o alarme, **Trocar doca**
chama para outra doca, **Encostou na doca** move o caminhão para "Na doca". Com o caminhão na doca, **CHAMAR MOTORISTA**
pede o motivo (carga/descarga concluída, comparecer ao caminhão, documentos, mudar de doca) e o celular vibra de novo.
**Liberar saída** encerra. Na portaria, **Histórico** mostra a linha do tempo completa.

A coluna **Celular** mostra se a página do motorista está aberta agora e se ele ativou notificações.
Indicadores no topo: aguardando, chamados, a caminho, espera média (chegada → chamada) e chegadas do dia.

## 4. Roteiro de teste com celulares reais

Use HTTPS (seção 2). Teste ao menos um **Android** e um **iPhone**.

| # | Teste | Esperado | OK? |
|---|---|---|---|
| 1 | Cadastrar chegada e ler o QR individual | Celular abre na tela do motorista | ☐ |
| 2 | Tocar ATIVAR ALERTAS e Permitir | Tela "1º na fila", itens verdes | ☐ |
| 3 | Chamar com a **página aberta** | Vibra + toca + tela laranja com a doca | ☐ |
| 4 | Tocar ESTOU INDO | Dashboard mostra "Estou indo" com aviso sonoro | ☐ |
| 5 | Nova chegada; bloquear a tela do celular; chamar | Notificação no bloqueio com vibração (se permitida) | ☐ |
| 6 | Desligar dados móveis e chamar | Dashboard avisa "SEM CONEXÃO" | ☐ |
| 7 | Tela da equipe aberta no PC do recebimento; chamar um caminhão de recebimento | Tela pisca e apita até CIENTE; portaria mostra "ciente" | ☐ |
| 8 | Celular no silencioso / "Não perturbe" | Registrar o que acontece (depende do aparelho) | ☐ |

## 5. Limitações conhecidas (honestas)

- **Sem internet no celular, não há chamada.** Para esses motoristas, a portaria chama pessoalmente ou por telefone.
- **iPhone:** o Safari **não vibra** por página web. Notificação com tela bloqueada só funciona se o motorista
  adicionar a página à **Tela de Início** (Compartilhar → Adicionar à Tela de Início, iOS 16.4+) e permitir notificações.
  Com a página aberta, o iPhone toca o som (se o volume estiver ligado).
- **Android/Chrome:** vibra com a página aberta. Com tela bloqueada, depende da permissão de notificação
  e da economia de bateria do aparelho (alguns fabricantes atrasam notificações).
- **Silencioso / Não perturbe** podem silenciar som e vibração — nenhum sistema web consegue forçar.
- Protótipo: login por PIN único, sem gestão de usuários; sessões são perdidas ao reiniciar o servidor.

## 6. Estrutura

```
src/server.js        API, tempo real (SSE), Web Push, QR Code, indicadores
src/db.js            Banco SQLite (data/patio.db)
public/index.html    Portaria + dashboard          public/portaria.js
public/equipe.html   Tela da equipe que pisca/apita (equipe.js, equipe.css)
public/cartaz.html   Cartaz A4 com o QR fixo
public/m/            Página do motorista (driver.js), service worker (sw.js), manifest
data/vapid.json      Chaves do Web Push geradas na 1ª execução (não compartilhe)
```
