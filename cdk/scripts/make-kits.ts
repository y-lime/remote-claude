/**
 * デプロイ済みのメンバーごとの EC2（スタック RemoteClaude-<name>）から、メンバーに渡す接続キットを作る。
 * `npm run deploy` の最後に実行される（`npm run kits` で単独でも実行できる）。
 *
 *   ../kits/remote-claude-<name>/      接続スクリプト、接続先の設定、導入説明書、devcontainer のひな形
 *   ../kits/remote-claude-<name>.zip   上を固めたもの。これを渡す
 *
 * スタックの出力は CloudFormation から読むので、一部のスタックだけをデプロイしたあとでも全員分を作り直せる。
 */
import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const cdkDir = path.join(__dirname, '..');
const repoDir = path.join(cdkDir, '..');
const kitsDir = path.join(repoDir, 'kits');

interface Stack {
  StackName: string;
  StackStatus: string;
  Outputs?: { OutputKey: string; OutputValue: string }[];
}

function region(): string {
  if (process.env.REMOTE_CLAUDE_REGION) return process.env.REMOTE_CLAUDE_REGION;
  const cdkJson = JSON.parse(fs.readFileSync(path.join(cdkDir, 'cdk.json'), 'utf8'));
  return cdkJson.context?.region ?? 'ap-northeast-1';
}

function listMemberStacks(regionName: string): Stack[] {
  // シェル経由にするのは、Windows で aws.cmd などの .exe 以外も見つけられるようにするため（引数は検査済みのリージョンだけ）
  if (!/^[a-z0-9-]+$/.test(regionName)) throw new Error(`リージョンが不正です: ${regionName}`);
  const out = execSync(`aws cloudformation describe-stacks --region ${regionName} --output json`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const stacks = (JSON.parse(out).Stacks ?? []) as Stack[];
  return stacks.filter((s) => s.StackName.startsWith('RemoteClaude-') && !s.StackStatus.startsWith('DELETE'));
}

// PowerShell 5.1 は BOM のない UTF-8 を ANSI として読むので BOM を付ける
function writeUtf8Bom(file: string, text: string): void {
  fs.writeFileSync(file, '\ufeff' + text.replace(/\r?\n/g, '\r\n'), 'utf8');
}

function zip(dir: string, zipFile: string): void {
  // Windows 10 以降に標準で入っている bsdtar は、-a で拡張子から zip を選ぶ
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-a', '-c', '-f', zipFile, '-C', path.dirname(dir), path.basename(dir)]);
}

function makeKit(stack: Stack, regionName: string): string | undefined {
  const outputs = Object.fromEntries((stack.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
  const name = outputs.MemberName ?? stack.StackName.replace(/^RemoteClaude-/, '');
  const instanceId = outputs.InstanceId;
  // 作成に失敗したスタックなど
  if (!instanceId) return undefined;
  const hostAlias = `remote-claude-${name}`;

  const dir = path.join(kitsDir, hostAlias);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of ['remote.cmd', 'remote.ps1']) {
    fs.copyFileSync(path.join(repoDir, 'scripts', file), path.join(dir, file));
  }
  fs.cpSync(path.join(repoDir, 'devcontainer-template', '.devcontainer'), path.join(dir, '.devcontainer'), { recursive: true });

  writeUtf8Bom(path.join(dir, 'remote-claude.config.ps1'), [
    `# remote-claude の接続先（${stack.StackName}）。cdk/scripts/make-kits.ts が作ったもの。remote.ps1 が読む`,
    `$Region = '${regionName}'`,
    `$InstanceId = '${instanceId}'`,
    `$HostAlias = '${hostAlias}'`,
    // 子プロセスの aws が使う。メンバーが自分で AWS_PROFILE を決めているときはそちらを使う
    `if (-not $env:AWS_PROFILE) { $env:AWS_PROFILE = 'remote-claude' }`,
    '',
  ].join('\n'));

  const readme = fs.readFileSync(path.join(cdkDir, 'assets', 'kit-README.md'), 'utf8')
    .replaceAll('__NAME__', name)
    .replaceAll('__HOST_ALIAS__', hostAlias)
    .replaceAll('__INSTANCE_ID__', instanceId)
    .replaceAll('__REGION__', regionName)
    .replaceAll('__IDLE_STOP_MINUTES__', outputs.IdleStopMinutes ?? '30');
  fs.writeFileSync(path.join(dir, 'README.md'), readme, 'utf8');

  const zipFile = `${dir}.zip`;
  zip(dir, zipFile);
  return zipFile;
}

const regionName = region();
const stacks = listMemberStacks(regionName);
// 消したメンバーのキットが残らないよう、毎回作り直す
fs.rmSync(kitsDir, { recursive: true, force: true });
fs.mkdirSync(kitsDir, { recursive: true });
if (stacks.length === 0) {
  console.log(`${regionName} に RemoteClaude-<name> のスタックがありません`);
}
for (const stack of stacks) {
  const zipFile = makeKit(stack, regionName);
  console.log(zipFile
    ? `${stack.StackName} → ${path.relative(repoDir, zipFile)}`
    : `${stack.StackName} は出力に InstanceId がないので飛ばします（${stack.StackStatus}）`);
}
