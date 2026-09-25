export const CURRENT_TIME_TOOL = {
  name: "get_current_time",
  description:
    "Получить текущую дату и время по часам сервера в часовом поясе браузера пользователя. Если браузер не сообщил допустимый пояс, используется UTC с явным признаком fallback. Для вопросов о сегодняшней дате, времени, возрасте и ближайшем дне рождения; не брать сегодняшнюю дату из истории диалога или знаний модели.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
} as const;

/** Browser supplies only a zone preference, never the trusted current date. */
export function researchClock(browserTimeZone: unknown) {
  let timeZone = "UTC",
    source: "browser" | "utc_fallback" = "utc_fallback";
  if (
    typeof browserTimeZone === "string" &&
    browserTimeZone.length <= 100 &&
    /^[A-Za-z0-9_+\-/]+$/.test(browserTimeZone)
  ) {
    try {
      timeZone = new Intl.DateTimeFormat("en", {
        timeZone: browserTimeZone,
      }).resolvedOptions().timeZone;
      source = "browser";
    } catch {
      // Unsupported or untrusted zone: do not guess the user's location.
    }
  }
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
  return (now = new Date()) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(now).map(({ type, value }) => [type, value]),
    );
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    return {
      utc: now.toISOString(),
      date,
      localDateTime: `${date}T${parts.hour}:${parts.minute}:${parts.second}`,
      utcOffset:
        parts.timeZoneName === "GMT"
          ? "+00:00"
          : parts.timeZoneName.replace(/^GMT/, ""),
      timeZone,
      timeZoneSource: source,
      clockSource: "server" as const,
    };
  };
}

export function researchTimeInstruction(
  time: ReturnType<ReturnType<typeof researchClock>>,
) {
  return [
    `Актуальные дата и время текущего запроса, полученные от сервера: ${JSON.stringify(time)}.`,
    "Сегодня — date из этого контекста; он приоритетнее старых дат из истории, summary/compaction и знаний модели. Никогда не выдавай дату обучения модели за сегодняшнюю. При необходимости уточнить время вызови get_current_time. Часовой пояс — настройка браузера, не доказательство местонахождения пользователя.",
    time.timeZoneSource === "utc_fallback"
      ? "Часовой пояс пользователя неизвестен: дата и время указаны по UTC; если местная дата важна, явно укажи это, не угадывай пояс."
      : "",
    "Для возраста вызови get_person (для «я» используй привязанный personId) и используй вычисленные сервером age.label и age.asOfDate: код уже учитывает день рождения. kind=at_death означает возраст на дату смерти, не текущий возраст; label=null — данных для расчёта нет. Если известен только год/месяц, сохрани оговорку приблизительного возраста, не придумывай точную дату. Историческая дата в вопросе пользователя — отдельная дата расчёта, а не замена сегодняшней: текущий age.label к ней не относится.",
  ]
    .filter(Boolean)
    .join("\n");
}
