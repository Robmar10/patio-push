# PÁTIO PUSH — controle de pátio e chamada gratuita de motoristas (v3)

**Fluxo:** a **Portaria lança a chegada** (autorização R-0001 / E-0002), mostra o **QR Code** e confere o celular do
motorista (3 marcas verdes). A tela do **Recebimento/Expedição** pisca. A **equipe chama e indica a doca**: o celular
**vibra e toca, mesmo bloqueado ou em outro app**. O motorista toca **ESTOU INDO** (na página ou direto na notificação).
Depois a equipe marca **Encostou na doca**, pode **chamar de novo ou mandar recados** (carga concluída, buscar nota,
assinar canhoto, documentos, mudar de doca, texto livre) e pode **passar o caminhão para a outra equipe**
(descarregou no Recebimento → carrega na Expedição). Por fim, **Liberar saída**, e a **portaria registra a saída**.

**A chamada diz o que fazer:** Recebimento = **DESCARREGAR NA DOCA 04**; Expedição = **CARREGAR NA DOCA 07**.

**Sem custo por mensagem** (não usa SMS). O plano B, quando o celular não recebe, é **ligar para o motorista** (o número aparece na tela da equipe).

## O que mudou na v3

| Problema encontrado | O que a v3 faz |
|---|---|
| Ninguém sabia se a notificação **chegou** no celular ("enviada" só quer dizer que o Google recebeu) | O celular confirma a chegada. A equipe vê **📳 chegou no celular 14:02** |
| Chamada que não chega = caminhão que "some" | **Vigia de 75 s:** se não chegou ou ninguém respondeu, a tela da equipe pisca em vermelho com o botão **Ligar** prontos |
| Motorista saía da guarita com o celular sem notificação | O QR da portaria mostra **3 checagens ao vivo** (página aberta, notificações, teste) e o botão **TESTAR AVISO** |
| No Android, o pedido de permissão era feito tarde e podia ser bloqueado | A permissão é pedida **no instante do toque**, e a tela explica como desbloquear, inclusive nas configurações do Android |
| Motorista precisava ficar com a tela aberta | A notificação **se repete a cada 30 s (até 5 min)** e tem o botão **✅ ESTOU INDO** |
| Material que descarrega no Recebimento e carrega na Expedição | **Operação dupla** no cadastro e botão **ENVIAR P/ EXPEDIÇÃO**. O caminhão volta para a fila da outra equipe, que é avisada |
| Chamar para buscar nota ou assinar canhoto | **Recados** com local (doca, escritório do Recebimento/Expedição, portaria), **também com o caminhão na fila** |
| Sem controle de saída | **Registrar saída** na portaria, com indicador **tempo no pátio** |
| iPhone perdia o acesso ao adicionar à Tela de Início | O ícone abre já identificado |
| Celular abria versão antiga da página depois de atualizar | Páginas sempre conferem se há versão nova |

## 0. Colocar na nuvem (sem instalar nada)

Siga o **GUIA-NUVEM.md** (GitHub + Render + Neon, todos gratuitos).
**Para atualizar uma instalação existente:** no GitHub → *Add file → Upload files* → arraste as pastas `src` e `public`
(e os demais arquivos da raiz, se vierem no pacote) → *Commit changes*. O banco é migrado sozinho e os dados continuam.

## 1. Telas

| Endereço | Quem usa | Para quê |
|---|---|---|
| `/` | Portaria | Lançar chegada, QR + checagem do celular, acompanhar o pátio, registrar saída |
| `/equipe` | Recebimento / Expedição (PC ou TV) | Chamar, recados, doca, transferir, liberar saída |
| `/m/` | Motorista (celular) | Receber chamadas e recados |
| `/cartaz` | Portaria | QR fixo para imprimir (alternativa ao QR individual) |

## 2. Operação passo a passo

**Portaria:**
1. Escolha RECEBIMENTO ou EXPEDIÇÃO e preencha os dados. Se o caminhão vai fazer as duas operações, marque **Operação dupla**.
2. Clique em **LANÇAR NA FILA E GERAR QR**. A janela mostra o que o motorista digita no **cartaz**: placa + final do celular, por exemplo `ABC1D23` + `4321`.
   Ele lê o **cartaz fixo** (ou o QR individual), confere o **nome e a placa dele** na tela, toca em **ATIVAR ALERTAS** e depois em **PERMITIR**.
   - Cada celular fica ligado a **uma única placa**. A chamada vai só para o celular daquela placa, mesmo com vários caminhões aguardando.
   - Se o celular já tinha um acesso antigo salvo, a tela pergunta **"É você?"** antes de mostrar qualquer coisa.
3. Na janela do QR, espere ficar ✔ em **página aberta** e **notificações permitidas**. Peça para ele **bloquear o celular** e clique em **TESTAR AVISO NO CELULAR**.
   Quando aparecer **TUDO CERTO**, libere o motorista para o pátio.
   - Notificações bloqueadas: a tela do motorista mostra como liberar. Se não der, a equipe liga para o motorista.
4. Quando a equipe libera, a linha fica **Liberado — sair**. Na saída, clique em **REGISTRAR SAÍDA**.

**Recebimento / Expedição (`/equipe`):**
- **Na fila:**
  - **CHAMAR MOTORISTA** → doca.
  - **Recado** → buscar nota fiscal, assinar canhoto, documentos ou texto livre → local.
  - **Passar p/ a outra equipe**, se a portaria lançou na equipe errada.
- **Chamados:** **Rechamar**, **Trocar doca**, **Encostou na doca** e **Voltar para a fila**.
- **Na doca:**
  - **CHAMAR MOTORISTA** → carga concluída, ir ao caminhão, mudar de doca, nota, canhoto, documentos ou texto livre.
  - **ENVIAR P/ EXPEDIÇÃO** (ou Recebimento): aparece em destaque quando o caminhão foi lançado como operação dupla.
  - **Liberar saída.**
- Cada cartão mostra:
  - se a chamada **chegou no celular** (📳);
  - se ele **respondeu** (✔);
  - o botão **Ligar**, com o número do motorista.
- **Alerta vermelho** "O CELULAR NÃO RECEBEU A CHAMADA" ou "MOTORISTA NÃO RESPONDEU": ligue para o motorista, depois **CIENTE — VOU AVISAR**.

**Motorista:**
- Depois de permitir as notificações, **pode bloquear o celular ou usar outros apps**.
- A chamada chega como notificação com vibração e se repete até ele responder. Ele pode tocar em **✅ ESTOU INDO** na própria notificação.

## 3. Roteiro de teste com celulares reais

Faça com pelo menos 3 aparelhos: **Samsung**, **Motorola ou Xiaomi** e **iPhone**.

| # | Teste | Esperado | OK? |
|---|---|---|---|
| 1 | Lançar chegada, ler o QR, tocar em ATIVAR ALERTAS e depois em Permitir | Quadro **verde** no celular; ✔✔ na janela do QR | ☐ |
| 2 | Celular **bloqueado**, portaria clica em TESTAR AVISO | Notificação de teste chega; portaria mostra **TUDO CERTO** | ☐ |
| 3 | Celular bloqueado, equipe chama para uma doca | Notificação vibra e repete a cada 30 s; equipe vê **📳 chegou** | ☐ |
| 4 | Tocar em **✅ ESTOU INDO** na notificação, sem abrir a página | Equipe pisca "MOTORISTA A CAMINHO" e as repetições param | ☐ |
| 5 | Recado na fila: **Buscar nota fiscal → Escritório Expedição** | Celular mostra o recado e o local | ☐ |
| 6 | Na doca: **Assinar canhoto** e depois **ENVIAR P/ EXPEDIÇÃO** | Celular: "Libere a doca e aguarde a Expedição"; tela da Expedição pisca | ☐ |
| 7 | **Desligar os dados móveis** e chamar | Em ~75 s a equipe recebe o alerta vermelho com o botão Ligar | ☐ |
| 8 | Liberar saída → portaria **REGISTRAR SAÍDA** | Celular "Boa viagem"; indicador **tempo no pátio** | ☐ |
| 9 | Celular no silencioso / "Não perturbe" | Registrar o que acontece (depende do aparelho) | ☐ |

## 4. Limitações (honestas)

- **Sem internet no celular, nenhuma notificação chega.** O vigia avisa a equipe, e o plano B é ligar para o motorista.
- **Notificações bloqueadas:** o site não consegue desbloquear sozinho. O motorista precisa liberar nas configurações; a tela dele mostra como.
- **iPhone:**
  - não vibra por página web;
  - com a tela bloqueada, só recebe se a página for adicionada à **Tela de Início** (iOS 16.4+) e as notificações forem permitidas.
- **Android:** a economia de bateria de alguns fabricantes (Xiaomi, Samsung) pode atrasar notificações. Se acontecer, oriente: **Configurações → Aplicativos → Chrome → Bateria → Sem restrições**.
- **Silencioso / Não perturbe** podem silenciar som e vibração. Nenhum sistema web consegue forçar.
- **Repetições e vigia ficam na memória do servidor:** se o Render reiniciar no meio de uma chamada, a repetição daquela chamada para (a notificação já entregue continua no celular).
- Login por PIN único, sem gestão de usuários.

## 5. Rodar no computador (opcional)

Requisito: Node.js 22.5 ou superior. Rode `npm install`, depois `npm start` e abra `http://localhost:3100`.
Variáveis úteis:

| Variável | Para quê | Padrão |
|---|---|---|
| `PORTARIA_PIN` | PIN de acesso | — |
| `DATABASE_URL` | Cópia dos dados no Neon | — |
| `SITE_NAME` | Nome que aparece nas mensagens | — |
| `PLACES` | Locais dos recados, separados por vírgula | `ESCRITÓRIO RECEBIMENTO,ESCRITÓRIO EXPEDIÇÃO,PORTARIA` |
| `RING_EVERY_MS` / `RING_MAX` | Intervalo e quantidade de repetições | `30000` / `10` |
| `WATCH_MS` | Tempo até o alerta de "não recebeu / não respondeu" | `75000` |

## 6. Estrutura

```
src/server.js        API, tempo real (SSE), Web Push, recados, transferência, vigia, QR Code, indicadores
src/db.js            Banco SQLite + migração automática das versões anteriores
src/start.js         Início: restaura/salva a cópia no Postgres externo (Neon)
public/index.html    Portaria (portaria.js)
public/equipe.html   Recebimento / Expedição (equipe.js, equipe.css)
public/m/            Motorista: driver.js, sw.js (notificações, confirmação de entrega, ESTOU INDO na notificação)
public/cartaz.html   Cartaz A4 com o QR fixo
```
