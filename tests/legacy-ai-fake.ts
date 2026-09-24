// Keep existing behavioral fixtures while the transport moves to Responses.
// This adapter emulates provider-side conversation history; production does not use it.
export function adaptLegacyAiFake(legacy: typeof fetch): typeof fetch {
  const histories = new Map<string, Array<Record<string, unknown>>>();
  let conversation = 0;
  let responseId = 0;
  return async (url, init) => {
    const address = String(url);
    if (address.endsWith("/conversations") && init?.method === "POST") {
      const id = `test-conversation-${++conversation}`;
      histories.set(id, []);
      return Response.json({ id, object: "conversation" });
    }
    if (address.includes("/conversations/") && init?.method === "DELETE")
      return Response.json({ deleted: true });
    if (!address.endsWith("/responses")) return legacy(url, init);

    const request = JSON.parse(String(init?.body)) as {
      conversation: string;
      input: string | Array<Record<string, unknown>>;
      instructions: string;
      tools: Array<{
        type: string;
        name: string;
        description: string;
        parameters: unknown;
      }>;
      stream?: boolean;
      model: string;
    };
    const history = histories.get(request.conversation);
    if (!history)
      return Response.json(
        { error: { message: "Conversation not found" } },
        { status: 404 },
      );
    const input = (
      typeof request.input === "string"
        ? [{ role: "user", content: request.input }]
        : request.input.map((item) =>
            item.type === "function_call_output"
              ? {
                  role: "tool",
                  tool_call_id: item.call_id,
                  content: item.output,
                }
              : {
                  role: item.role,
                  content: Array.isArray(item.content)
                    ? (item.content as Array<{ text?: string }>)
                        .map((part) => part.text || "")
                        .join("")
                    : item.content,
                },
          )
    ) as Array<Record<string, unknown>>;
    history.push(...input);
    const legacyBody = {
      model: request.model,
      messages: [{ role: "system", content: request.instructions }, ...history],
      tools: request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
      ...(request.stream ? { stream: true } : {}),
    };
    const result = await legacy(
      address.replace(/\/responses$/, "/chat/completions"),
      {
        ...init,
        body: JSON.stringify(legacyBody),
      },
    );
    if (!result.ok) return result;
    let message: {
      role: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
    let usage: unknown;
    if (request.stream) {
      const raw = await result.text();
      const calls = new Map<
        number,
        {
          id: string;
          function: { name: string; arguments: string };
        }
      >();
      let content = "";
      for (const frame of raw.split(/\r?\n\r?\n/)) {
        const data = frame
          .split(/\r?\n/)
          .find((line) => line.startsWith("data:"))
          ?.slice(5)
          .trim();
        if (!data || data === "[DONE]") continue;
        const chunk = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
          usage?: unknown;
        };
        content += chunk.choices?.[0]?.delta?.content || "";
        usage = chunk.usage || usage;
        for (const call of chunk.choices?.[0]?.delta?.tool_calls || []) {
          const current = calls.get(call.index) || {
            id: "",
            function: { name: "", arguments: "" },
          };
          current.id ||= call.id || "";
          current.function.name += call.function?.name || "";
          current.function.arguments += call.function?.arguments || "";
          calls.set(call.index, current);
        }
      }
      message = { role: "assistant", content, tool_calls: [...calls.values()] };
    } else {
      const data = (await result.json()) as {
        choices?: Array<{ message: typeof message }>;
        usage?: unknown;
      };
      message = data.choices?.[0]?.message || {
        role: "assistant",
        content: "",
      };
      usage = data.usage;
    }
    history.push(message as Record<string, unknown>);
    const response = {
      id: `test-response-${++responseId}`,
      status: "completed",
      output_text: message.content || "",
      output: (message.tool_calls || []).map((call) => ({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      usage,
    };
    return request.stream
      ? new Response(
          `data: ${JSON.stringify({ type: "response.completed", response })}\n\ndata: [DONE]\n\n`,
          {
            headers: { "Content-Type": "text/event-stream" },
          },
        )
      : Response.json(response);
  };
}
