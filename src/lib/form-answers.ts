/** First line of the timeline note that holds a Facebook lead's other form answers. */
export const FORM_ANSWERS_HEADING = "Facebook form answers:";

/**
 * Meta sends multiple-choice answers as option keys ("within_1_month", "yes,_this_fits_our_budget.").
 * A value with underscores and no spaces is such a key: show it as words. Typed answers stay as written.
 */
export function readableAnswer(value: string) {
  const v = value.trim();
  if (!v.includes("_") || /\s/.test(v)) return v;
  const words = v.replace(/_+/g, " ").replace(/\s+([,.?!])/g, "$1").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A field name ("company_name") as a label ("Company name"); a custom question stays as asked. */
export function readableQuestion(name: string) {
  const q = name.includes(" ") ? name.trim() : name.replace(/_/g, " ").trim();
  return q.charAt(0).toUpperCase() + q.slice(1);
}

/**
 * The question/answer pairs of a form-answers note, or null for any other note. Each line is
 * "question: answer"; older notes still hold raw option keys, so answers are tidied here too.
 */
export function parseFormAnswers(body: string | null | undefined) {
  if (!body?.startsWith(FORM_ANSWERS_HEADING)) return null;
  const pairs = body.slice(FORM_ANSWERS_HEADING.length).split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const at = line.indexOf(": ");
    if (at < 0) return { question: null, answer: readableAnswer(line) };
    return { question: line.slice(0, at), answer: readableAnswer(line.slice(at + 2)) };
  });
  return pairs.length ? pairs : null;
}
