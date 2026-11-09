/**
 * Minimal terminal styling for interactive commands. Everything goes to stderr so stdout stays
 * one JSON envelope, and styling switches off when stderr is not a terminal or NO_COLOR is set.
 */
const styled = (): boolean =>
  Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
const paint =
  (code: string) =>
  (text: string): string =>
    styled() ? `\x1b[${code}m${text}\x1b[0m` : text;

export const color = {
  bold: paint("1"),
  dim: paint("2"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  cyan: paint("36"),
};

export const say = (text = ""): void => {
  process.stderr.write(`${text}\n`);
};
export const heading = (text: string): void => say(`\n${color.bold(text)}`);
export const warn = (text: string): void =>
  say(`  ${color.yellow("[!!]")} ${text}`);

const FRAMES = ["|", "/", "-", "\\"];

/**
 * Runs one step behind a small ASCII spinner and ends with an [ok] or [!!] line. Steps whose
 * subprocesses print to the terminal (the faucet) pass spin: false so their output is not overwritten.
 */
export async function step<T>(
  label: string,
  run: () => Promise<T> | T,
  options: { spin?: boolean; done?: (result: T) => string } = {},
): Promise<T> {
  const live = styled() && options.spin !== false;
  let frame = 0,
    timer: NodeJS.Timeout | undefined;
  if (live) {
    process.stderr.write(`  ${color.cyan(FRAMES[0]!)} ${label}`);
    timer = setInterval(() => {
      frame = (frame + 1) % FRAMES.length;
      process.stderr.write(`\r  ${color.cyan(FRAMES[frame]!)} ${label}`);
    }, 120);
  } else say(`  ${color.dim("..")} ${label}`);
  const clear = () => {
    if (timer) clearInterval(timer);
    if (live) process.stderr.write("\r\x1b[2K");
  };
  try {
    const result = await run();
    clear();
    const detail = options.done?.(result);
    say(
      `  ${color.green("[ok]")} ${label}${detail ? color.dim(`  ${detail}`) : ""}`,
    );
    return result;
  } catch (error) {
    clear();
    say(`  ${color.red("[!!]")} ${label}`);
    throw error;
  }
}
