import chalk from "chalk";
import Table from "cli-table3";

export function isJsonMode(): boolean {
  if (process.env.DOTMOCK_OUTPUT === "json") return true;
  return process.argv.includes("--json");
}

export function json(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function table(headers: string[], rows: string[][]): void {
  if (isJsonMode()) return;

  const t = new Table({
    head: headers.map((h) => chalk.bold.cyan(h)),
    style: { head: [], border: [] },
  });

  for (const row of rows) {
    t.push(row);
  }

  console.log(t.toString());
}

export function success(msg: string): void {
  if (isJsonMode()) return;
  console.log(chalk.green("✔") + "  " + msg);
}

export function error(msg: string): void {
  console.error(chalk.red("✖") + "  " + msg);
}

export function info(msg: string): void {
  if (isJsonMode()) return;
  console.log(chalk.blue("ℹ") + "  " + msg);
}

export function methodColor(method: string): string {
  const upper = method.toUpperCase();
  switch (upper) {
    case "GET":
      return chalk.green(upper);
    case "POST":
      return chalk.blue(upper);
    case "PUT":
      return chalk.yellow(upper);
    case "PATCH":
      return chalk.magenta(upper);
    case "DELETE":
      return chalk.red(upper);
    case "QUERY":
      return chalk.cyan(upper);
    default:
      return chalk.white(upper);
  }
}
