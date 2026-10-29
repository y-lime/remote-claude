import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Node } from 'constructs';

/**
 * 外向き通信の構成。どれもインバウンドは全閉。
 * - nat:      プライベートサブネット + NAT。SSM と Bedrock は VPC エンドポイント経由
 * - public:   パブリックサブネット + パブリック IP。エンドポイントなし（最安）
 * - isolated: NAT なし。VPC エンドポイントだけで外には出られない
 */
export type Egress = 'nat' | 'public' | 'isolated';

/** メンバー1人ぶんの EC2（context の instances の1項目） */
export interface InstanceConfig {
  /** スタック名（RemoteClaude-<name>）と ssh の Host 名（remote-claude-<name>）に使う */
  readonly name: string;
  /** 接続を許可する既存の IAM ユーザー。RemoteClaudeUser ポリシーを付ける */
  readonly iamUser?: string;
  /** ec2-user の authorized_keys に登録する公開鍵。未指定なら登録しない */
  readonly sshPublicKey?: string;
  readonly instanceType: string;
  readonly volumeSizeGiB: number;
}

export interface RemoteClaudeConfig {
  readonly egress: Egress;
  readonly instances: InstanceConfig[];
  /** Claude Code の opus / sonnet / haiku に割り当てる Bedrock の推論プロファイル */
  readonly claudeOpusModel: string;
  readonly claudeSonnetModel: string;
  readonly claudeHaikuModel: string;
  /** 既定で使うモデル（ANTHROPIC_MODEL）。opus / sonnet / haiku の別名か、推論プロファイルの ID */
  readonly claudeModel: string;
  /** SSH と SSM の接続がなく、Claude Code も作業していない状態がこの分数続いたら停止する。0 なら止めない */
  readonly idleStopMinutes: number;
  /** true ならこのアプリで CodeArtifact のドメインとリポジトリを作る。false なら既存のものを使う */
  readonly codeArtifactCreate: boolean;
  readonly codeArtifactDomain: string;
  /** ドメインのアカウント。未指定ならスタックのアカウント */
  readonly codeArtifactDomainOwner?: string;
  /** Gradle が見るリポジトリ */
  readonly codeArtifactRepository: string;
}

/** context の instances の値。公開鍵は文字列（メンバーからもらった鍵）かファイル（自分の鍵）で渡す */
interface InstanceContext {
  iamUser?: string;
  sshPublicKey?: string;
  sshPublicKeyPath?: string;
  instanceType?: string;
  volumeSizeGiB?: number;
}

const EGRESS_VALUES: Egress[] = ['nat', 'public', 'isolated'];
const INSTANCE_NAME = /^[a-z0-9-]+$/;

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function readPublicKey(keyPath: string | undefined): string | undefined {
  if (!keyPath) return undefined;
  const resolved = expandHome(keyPath);
  return fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8').trim() : undefined;
}

/** cdk.json の context（-c で上書き可）から設定を読む */
export function loadConfig(node: Node): RemoteClaudeConfig {
  const egress = (node.tryGetContext('egress') ?? 'nat') as Egress;
  if (!EGRESS_VALUES.includes(egress)) {
    throw new Error(`context "egress" は ${EGRESS_VALUES.join(' / ')} のいずれか: ${egress}`);
  }

  const idleStopMinutes = Number(node.tryGetContext('idleStopMinutes') ?? 30);
  if (!Number.isInteger(idleStopMinutes) || idleStopMinutes < 0) {
    throw new Error(`context "idleStopMinutes" は 0 以上の整数: ${node.tryGetContext('idleStopMinutes')}`);
  }

  // instanceType と volumeSizeGiB は全員の既定値。instances の各項目で上書きできる
  const defaultInstanceType: string = node.tryGetContext('instanceType') ?? 't3.large';
  const defaultVolumeSizeGiB = Number(node.tryGetContext('volumeSizeGiB') ?? 100);
  const instanceContexts = (node.tryGetContext('instances') ?? {}) as Record<string, InstanceContext>;
  const instances = Object.entries(instanceContexts).map(([name, c]): InstanceConfig => {
    if (!INSTANCE_NAME.test(name)) {
      throw new Error(`context "instances" の名前に使えるのは英小文字、数字、- だけ: ${name}`);
    }
    return {
      name,
      iamUser: c.iamUser,
      sshPublicKey: c.sshPublicKey?.trim() || readPublicKey(c.sshPublicKeyPath),
      instanceType: c.instanceType ?? defaultInstanceType,
      volumeSizeGiB: Number(c.volumeSizeGiB ?? defaultVolumeSizeGiB),
    };
  });

  return {
    egress,
    instances,
    // jp. は日本国内のリージョンだけで処理する推論プロファイル。Opus 4.6 は jp. がないので global.
    // Claude 5 系はこのアカウントでは利用規約に同意できず使えない（2026-10-20 時点）
    claudeOpusModel: node.tryGetContext('claudeOpusModel') ?? 'global.anthropic.claude-opus-4-6-v1',
    claudeSonnetModel: node.tryGetContext('claudeSonnetModel') ?? 'jp.anthropic.claude-sonnet-4-6',
    claudeHaikuModel: node.tryGetContext('claudeHaikuModel') ?? 'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
    claudeModel: node.tryGetContext('claudeModel') ?? 'opus',
    idleStopMinutes,
    // -c codeArtifactCreate=false は文字列で渡ってくる
    codeArtifactCreate: String(node.tryGetContext('codeArtifactCreate') ?? 'true') !== 'false',
    codeArtifactDomain: node.tryGetContext('codeArtifactDomain') ?? 'remote-claude',
    codeArtifactDomainOwner: node.tryGetContext('codeArtifactDomainOwner'),
    codeArtifactRepository: node.tryGetContext('codeArtifactRepository') ?? 'libs',
  };
}
