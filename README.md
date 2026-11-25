simply-router — Especificação Consolidada
1. Objetivo
Criar um plugin local para o OpenCode chamado simply-router que faça rotação automática entre múltiplas API Keys do Token Harbor (tokenharbor.ai). Quando a key em uso esgotar seu limite semanal (retorno 429), ela entra em cooldown de 7 dias corridos e a próxima key disponível passa a ser usada. O plugin deve expor o comando /simplyrouter reset para limpar manualmente todos os cooldowns.

2. Requisitos decididos
2.1 Funcionais
ID	Requisito
F1	Interceptar requisições destinadas ao host tokenharbor.ai e injetar Authorization: Bearer <key> com a key disponível atual
F2	Rotação em round-robin: se a key atual falhar, avançar para a próxima key não bloqueada
F3	Detectar esgotamento via status HTTP 429 (limite semanal excedido), além de 401/403 (key inválida ou sem permissão)
F4	Ao detectar falha, marcar a key como em cooldown por 7 dias corridos (7 * 24 * 60 * 60 * 1000 ms)
F5	Se todas as keys estiverem em cooldown, não injetar key e registrar erro no log
F6	Registrar o comando /simplyrouter com subcomando reset que limpa todos os cooldowns e reinicia o índice para a primeira key
F7	Suportar múltiplas contas Token Harbor (cada key pertence a uma conta distinta, pois o limite é compartilhado por conta)
2.2 Não-funcionais
ID	Requisito
N1	Implementação simples, sem dependências externas obrigatórias
N2	Estado de cooldown em memória (Map), perdido ao reiniciar o OpenCode (persistência fica como extensão futura)
N3	Código em TypeScript, carregável pelo OpenCode via .opencode/plugins/
N4	Comando /simplyrouter reset deve executar a limpeza real do estado, não apenas responder ao usuário

3. Decisões técnicas

3.1 Hook principal: http.request
O plugin usa o hook http.request do OpenCode para modificar event.request.headers antes do envio, substituindo o Authorization. A filtragem é feita verificando se event.request.url contém tokenharbor.ai.

Limitação reconhecida: http.request não reenvia requisições que falharam. O retry automático depende do mecanismo nativo de retry do OpenCode (que reaciona http.request antes da próxima tentativa) ou de lógica adicional combinada com session.error. A versão inicial assume que o OpenCode reaciona http.request no retry; isso deve ser validado em teste (ver §5).

3.2 Detecção de falha: session.error
O hook session.error inspeciona status da resposta; se for 429, 401 ou 403, chama markKeyCooldown(currentKey) com o timestamp de expiração de 7 dias.

3.3 Comando /simplyrouter reset
Registrado via config.command no hook config. Como config.command é um template de prompt (não código executável), o template orienta o modelo a chamar uma custom tool simplyrouter_reset, registrada no próprio plugin, cujo execute limpa o Map de cooldowns e zera currentIndex.

3.4 Alternativa considerada e descartada
O padrão do plugin oc-zai-multi-account (hook em auth.loader + substituição de fetch) foi considerado como referência, mas descartado por ser mais complexo do que o necessário para o objetivo "simples para o OpenCode". O http.request atende ao caso de uso.

4. Estrutura do repositório

simply-router/
├── src/
│   └── main.ts                 # Lógica central (KEYS, COOLDOWN_MS, getNextAvailableKey, hooks, tool de reset)
├── .opencode/
│   ├── package.json            # (Opcional) dependências externas para o plugin
│   └── plugins/
│       └── shim.ts             # Reexporta SimplyRouter de src/main.ts
├── test/
│   ├── unit.test.ts            # Testes unitários (rotação, cooldown, reset)
│   └── e2e.test.ts             # Testes de integração (OpenCode real)
├── package.json                # Metadados do projeto, "type": "module", scripts
└── tsconfig.json               # Configuração do TypeScript

4.1 Papel de cada arquivo
src/main.ts: código completo do plugin (constantes, estado, funções auxiliares, SimplyRouter: Plugin).

.opencode/plugins/shim.ts: export { SimplyRouter } from "../../src/main" — permite que o OpenCode carregue o plugin direto do repositório durante o desenvolvimento.

.opencode/package.json: declarado se houver dependências npm; o OpenCode roda bun install em .opencode/ na inicialização.

test/unit.test.ts: bun test sobre as funções puras (getNextAvailableKey, markKeyCooldown, resetAllCooldowns).

test/e2e.test.ts: dispara opencode via Bun.$ e valida troca de key no log real.

package.json (raiz): "type": "module", scripts "test": "bun test", "dev": "opencode".

tsconfig.json: configuração para o editor e tsc --noEmit.

5. Plano de testes

5.1 Testes unitários (sem rede)
Caso	Entrada	Saída esperada
T1	Nenhuma key em cooldown, currentIndex = 0	getNextAvailableKey() retorna KEYS[0]
T2	KEYS[0] em cooldown	getNextAvailableKey() retorna KEYS[1]
T3	Todas as keys em cooldown	getNextAvailableKey() retorna null
T4	KEYS[0] em cooldown com timestamp expirado	getNextAvailableKey() retorna KEYS[0]
T5	Após resetAllCooldowns()	cooldowns.size === 0 e currentIndex === 0
T6	markKeyCooldown(key)	cooldowns.get(key) ≈ Date.now() + 7 dias

5.2 Teste de integração (e2e)
Objetivo: confirmar que, após uma key entrar em cooldown, a próxima requisição usa outra key.

Preparação: reduzir temporariamente COOLDOWN_MS para 30_000 (30 s) em ambiente de teste, ou substituir uma das keys por uma string inválida para forçar 401.

Passos:

Iniciar OpenCode no diretório do repositório (opencode).

Enviar uma mensagem qualquer que dispare requisição ao Token Harbor.

Forçar falha: usar key inválida em KEYS[0] ou aguardar 429 real.

Verificar no log (client.app.log ou ~/.local/share/opencode/log/) a mensagem simply-router: key #1 em cooldown.

Enviar nova mensagem; o log deve indicar o uso de key #2 (adicionar log simply-router: usando key #N temporariamente).

Digitar /simplyrouter reset; o modelo deve chamar simplyrouter_reset e o log deve confirmar a limpeza.

Enviar nova mensagem; o log deve voltar a key #1.

5.3 Teste de compatibilidade do hook
Validar na versão real do OpenCode se event.request.headers.set está disponível e se http.request é reacionado em retry. Se não funcionar, adaptar para o padrão auth.loader + substituição de fetch (referência: oc-zai-multi-account).

6. Premissas e riscos
P1: As keys em KEYS pertencem a contas distintas do Token Harbor (o free tier compartilha limite por conta).

P2: O Token Harbor autentica via header Authorization: Bearer <key>. Se usar outro header, ajustar event.request.headers.set.

R1: O estado de cooldown é em memória; reiniciar o OpenCode perde os cooldowns. Extensão futura: persistir em ~/.config/opencode/simply-router-state.json.

R2: O hook http.request pode não ser reacionado no retry dependendo da versão do OpenCode; validar em teste (§5.3).

R3: /simplyrouter reset depende de o modelo seguir o template e chamar a tool; testar em §5.2.

7. Código de referência (esqueleto de src/main.ts)
typescript
import type { Plugin } from "@opencode-ai/plugin"

const KEYS = [
  "thk_live_conta1_key",
  "thk_live_conta2_key",
  "thk_live_conta3_key",
]
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
const TOKEN_HARBOR_HOST = "tokenharbor.ai"

const cooldowns = new Map<string, number>()
let currentIndex = 0

function getNextAvailableKey(): { key: string; index: number } | null {
  const now = Date.now()
  for (let i = 0; i < KEYS.length; i++) {
    const idx = (currentIndex + i) % KEYS.length
    const key = KEYS[idx]
    const until = cooldowns.get(key)
    if (!until || now >= until) {
      currentIndex = idx
      return { key, index: idx }
    }
  }
  return null
}

function markKeyCooldown(key: string) {
  cooldowns.set(key, Date.now() + COOLDOWN_MS)
}

function resetAllCooldowns() {
  cooldowns.clear()
  currentIndex = 0
}

export const SimplyRouter: Plugin = async ({ client }) => {
  return {
    config: async (config) => {
      config.command = config.command || {}
      config.command["simplyrouter"] = {
        template: "Chame a ferramenta simplyrouter_reset para resetar todos os cooldowns do simply-router.",
        description: "simply-router: '/simplyrouter reset' limpa todos os cooldowns.",
      }
    },
    "http.request": async (event) => {
      if (!event.request.url?.includes(TOKEN_HARBOR_HOST)) return
      const selected = getNextAvailableKey()
      if (selected) {
        event.request.headers.set("Authorization", `Bearer ${selected.key}`)
      } else {
        await client.app.log({
          level: "error",
          message: "simply-router: todas as keys em cooldown. Use /simplyrouter reset.",
        })
      }
    },
    "session.error": async (input, output) => {
      const err = output as any
      const status = err?.status ?? err?.response?.status
      if (status === 429 || status === 401 || status === 403) {
        const currentKey = KEYS[currentIndex]
        if (currentKey) {
          markKeyCooldown(currentKey)
          await client.app.log({
            level: "warn",
            message: `simply-router: key #${currentIndex + 1} em cooldown por 7 dias (status ${status}).`,
          })
        }
      }
    },
    // Tool registrada para o comando /simplyrouter reset (implementação a completar
    // de acordo com a API de custom tools da versão do OpenCode em uso)
  }
}

8. Itens em aberto
API exata de custom tools na versão do OpenCode em uso (necessária para concluir simplyrouter_reset).

Confirmar se http.request é reacionado em retry (define se o retry automático é "silencioso" ou requer lógica adicional).

Decidir se a persistência de cooldown em disco entra na versão inicial ou fica como extensão.