/**
 * Подмена /usr/bin/security для тестов хранилища токенов: записи лежат в JSON-файле FAKE_KEYCHAIN, каждый вызов
 * дописывает аргументы и stdin в FAKE_KEYCHAIN_LOG. Понимает find-, add- (в интерактивном режиме -i) и
 * delete-generic-password; нет записи - код 44, как у настоящего security.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const file = process.env.FAKE_KEYCHAIN!;
const items = (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) as Record<string, string>;
const save = () => writeFileSync(file, JSON.stringify(items));
const opt = (args: string[], flag: string) => args[args.indexOf(flag) + 1] ?? '';
const key = (args: string[]) => `${opt(args, '-s')}/${opt(args, '-a')}`;
const argv = process.argv.slice(2);
const stdin = argv[0] === '-i' ? readFileSync(0, 'utf8') : '';
appendFileSync(process.env.FAKE_KEYCHAIN_LOG!, `${JSON.stringify({ argv, stdin })}\n`);

function run(args: string[]): number {
  const [command, ...rest] = args;
  if (command === 'find-generic-password') {
    const value = items[key(rest)];
    if (value === undefined) return 44;
    process.stdout.write(`${value}\n`);
    return 0;
  }
  if (command === 'add-generic-password') {
    if (!rest.includes('-U') && items[key(rest)] !== undefined) return 45;
    items[key(rest)] = Buffer.from(opt(rest, '-X'), 'hex').toString('utf8');
    save();
    return 0;
  }
  if (command === 'delete-generic-password') {
    if (items[key(rest)] === undefined) return 44;
    delete items[key(rest)];
    save();
    return 0;
  }
  return 1;
}

if (argv[0] === '-i') {
  for (const line of stdin.split('\n').filter(Boolean)) run(line.trim().split(/\s+/));
  process.exit(0);
}
process.exit(run(argv));
