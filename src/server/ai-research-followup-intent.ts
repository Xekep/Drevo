/** Only this admitted task participates in steering, never older chat topics.
 * Short modifiers keep the operation they qualify; replacement commands and
 * explicit cancellation supersede it. The model still receives each original
 * user message in order and resolves the detailed meaning itself.
 */
export function researchFollowupReplacesTask(update: string) {
    const text = update.trim();
    const cancelled = /^(?:(?:нет|стоп)[,!.\s]+(?:не\s|просто\s|отмен)|отмена(?:[\s,.!]|$)|отмени(?:[\s,.!]|$)|не\s+(?:скрывай|убирай|меняй|делай|создавай|добавляй|ищи))/iu.test(text);
    const replacement = /^(?:(?:теперь|вместо\s+этого|лучше|а\s+теперь)[,\s]+)?(?:покажи|открой|скрой|убери|исключи|оставь|найди|расскажи|ответь|перейди|приблизь|оптимизируй|добавь|измени|создай)(?:[\s,.!]|$)/iu.test(text);
    return cancelled || replacement;
}

export function researchFollowupMessage(current: string, updates: readonly string[]) {
  for (const update of updates) {
    const text = update.trim();
    current = researchFollowupReplacesTask(text) ? text : `${current}\nУточнение пользователя: ${text}`;
  }
  return current;
}
