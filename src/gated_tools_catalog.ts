/**
 * gated_tools_catalog.ts — автоматический справочник гейтированных тулов
 * (ТЗ `docs/TZ_automation_key_method_catalog.md`).
 *
 * Цель: список методов, которые можно выбрать в scope automation_key
 * (`<service>:<tool>`, см. `automation_key.ts`'s `scopeCovers`), НИГДЕ не
 * поддерживается руками — он получается протокольным `tools/list` у уже
 * собранного `McpServer`, тем же путём, каким его видит любой MCP-клиент.
 *
 * Способ получения — `InMemoryTransport.createLinkedPair()` +
 * `Client.listTools()`, штатная публичная утилита самого SDK (используется
 * в его собственных тестах для ровно этого сценария — "клиент и сервер в
 * одном процессе"). Сознательно НЕ читаем приватное поле `_registeredTools`
 * у `McpServer`: оно физически доступно, но не часть публичного контракта
 * SDK и может измениться в любом патч-релизе без предупреждения.
 *
 * Критерий "гейтирован" — тул несёт параметр `automation_key` в своей
 * JSON Schema (`inputSchema.properties.automation_key`). Ровно это поле
 * обязан нести каждый инструмент, прошедший через `requireConsent(...)` с
 * `automationKey`/`checkAutomationKey` в параметрах (ТЗ
 * `TZ_automation_key_consent_gate.md`) — значит критерий точный, без
 * отдельного ручного списка имён.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export interface GatedToolInfo {
  name: string;
  description: string;
}

/** UI-справочник не обязан таскать длинные докстринги — обрезаем разумно. */
const DESCRIPTION_MAX_LEN = 200;

function truncateDescription(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= DESCRIPTION_MAX_LEN) return trimmed;
  return trimmed.slice(0, DESCRIPTION_MAX_LEN - 1).trimEnd() + "…";
}

/**
 * Возвращает `{name, description}` для КАЖДОГО тула уже собранного `server`,
 * чья JSON Schema несёт параметр `automation_key` — то есть каждый тул,
 * прошедший через `requireConsent` с включённой automation_key-веткой.
 *
 * Открывает связанную пару in-memory транспортов, подключает к ним лёгкий
 * `Client`, зовёт протокольный `tools/list` и закрывает оба конца — ничего
 * не остаётся висеть после возврата.
 */
export async function listGatedTools(server: McpServer): Promise<GatedToolInfo[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gated-tools-catalog", version: "1.0.0" }, { capabilities: {} });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools
      .filter((tool) => {
        const properties = tool.inputSchema?.properties;
        return !!properties && Object.prototype.hasOwnProperty.call(properties, "automation_key");
      })
      .map((tool) => ({
        name: tool.name,
        description: truncateDescription(tool.description ?? ""),
      }));
  } finally {
    await client.close();
    await server.close();
  }
}
