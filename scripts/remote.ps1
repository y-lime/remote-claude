<#
リモートの Claude Code 環境（EC2）を手元から操作する。

  remote.ps1 start              起動して、SSM で接続できるようになるまで待つ
  remote.ps1 stop               停止する
  remote.ps1 status             状態を表示する
  remote.ps1 ssh [ssh の引数]   止まっていたら起動してから ssh で接続する（~/.ssh/config の Host remote-claude を使う）
  remote.ps1 shell              止まっていたら起動してから SSM で ec2-user のシェルを開く（SSH 鍵は不要）
  remote.ps1 tmux [名前]        shell と同じだが、tmux のセッションに入る（既定 main。なければ作る。切断しても作業が続く）
  remote.ps1 ssh-config         ~/.ssh/config に追記する設定を表示する
  remote.ps1 proxy <id> <port>  ssh の ProxyCommand 用。止まっていたら起動してから SSH over SSM をつなぐ

環境変数（任意）:
  REMOTE_CLAUDE_REGION       既定 ap-northeast-1
  REMOTE_CLAUDE_STACK        既定 RemoteClaudeStack
  REMOTE_CLAUDE_INSTANCE_ID  指定するとスタックの出力を読まない
  AWS_PROFILE                AWS CLI のプロファイル
#>

$ErrorActionPreference = 'Stop'

$Region = if ($env:REMOTE_CLAUDE_REGION) { $env:REMOTE_CLAUDE_REGION } else { 'ap-northeast-1' }
$StackName = if ($env:REMOTE_CLAUDE_STACK) { $env:REMOTE_CLAUDE_STACK } else { 'RemoteClaudeStack' }
$HostAlias = 'remote-claude'
$SsmTimeoutSec = 300

# proxy では標準出力が SSH の通信路になるので、メッセージは必ず標準エラーに出す（Write-Host は使わない）
function Log([string]$Message) {
  [Console]::Error.WriteLine("[remote-claude] $Message")
}

function Invoke-Aws {
  $out = & aws @args --region $Region --output text
  if ($LASTEXITCODE -ne 0) { throw "aws $($args -join ' ') が失敗しました（終了コード $LASTEXITCODE）" }
  return $out
}

function Get-InstanceId {
  if ($env:REMOTE_CLAUDE_INSTANCE_ID) { return $env:REMOTE_CLAUDE_INSTANCE_ID }
  $id = Invoke-Aws cloudformation describe-stacks --stack-name $StackName `
    --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue"
  if (-not $id -or $id -eq 'None') { throw "スタック $StackName の出力に InstanceId がありません" }
  return $id.Trim()
}

function Get-State([string]$Id) {
  return (Invoke-Aws ec2 describe-instances --instance-ids $Id `
      --query 'Reservations[0].Instances[0].State.Name').Trim()
}

# SSM Agent が Online になるまで待つ。起動直後は停止前の Online が残っていることがあるので、Since 以降の ping を待つ
function Wait-Ssm([string]$Id, $Since) {
  $deadline = (Get-Date).AddSeconds($SsmTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $info = Invoke-Aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$Id" `
      --query 'InstanceInformationList[0].[PingStatus,LastPingDateTime]'
    $status, $lastPing = ("$info".Trim() -split '\s+', 2)
    if ($status -eq 'Online') {
      if (-not $Since) { return }
      if ([datetime]::Parse($lastPing).ToUniversalTime() -ge $Since) { return }
    }
    Start-Sleep -Seconds 5
  }
  throw "$SsmTimeoutSec 秒待っても SSM に接続できる状態になりませんでした"
}

function Start-Remote([string]$Id) {
  $state = Get-State $Id
  $since = $null
  switch ($state) {
    'running' { }
    'pending' { Log "$Id は起動中です。待機します" }
    'stopping' {
      Log "$Id は停止処理中です。停止を待ってから起動します"
      Invoke-Aws ec2 wait instance-stopped --instance-ids $Id | Out-Null
      $state = 'stopped'
    }
    'stopped' { }
    default { throw "$Id の状態が $state のため起動できません" }
  }
  if ($state -eq 'stopped') {
    Log "$Id を起動します"
    # 時計のずれを見込んで少し前にする
    $since = (Get-Date).ToUniversalTime().AddSeconds(-30)
    Invoke-Aws ec2 start-instances --instance-ids $Id | Out-Null
  }
  if ($state -ne 'running') {
    Invoke-Aws ec2 wait instance-running --instance-ids $Id | Out-Null
    Log 'SSM Agent の接続を待っています'
  }
  Wait-Ssm $Id $since
}

function Show-Status([string]$Id) {
  $ping = Invoke-Aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$Id" `
    --query 'InstanceInformationList[0].PingStatus'
  "instance : $Id"
  "state    : $(Get-State $Id)"
  "ssm      : $("$ping".Trim())"
}

function Show-SshConfig([string]$Id) {
  $ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  @"
Host $HostAlias
    HostName $Id
    User ec2-user
    IdentityFile ~/.ssh/id_ed25519
    ProxyCommand $ps -NoProfile -ExecutionPolicy Bypass -File "$PSCommandPath" proxy %h %p
"@
}

$Command = if ($args.Count -gt 0) { $args[0] } else { 'help' }
# 要素が1つでも配列にする（if の結果は1要素だと文字列にほどけ、$Rest[0] が先頭の1文字になる）
$Rest = @(if ($args.Count -gt 1) { $args[1..($args.Count - 1)] })

try {
  switch ($Command) {
    'start' {
      $id = Get-InstanceId
      Start-Remote $id
      Log "$id に接続できます"
    }
    'stop' {
      $id = Get-InstanceId
      $state = Get-State $id
      if ($state -in 'running', 'pending') {
        Invoke-Aws ec2 stop-instances --instance-ids $id | Out-Null
        Log "$id の停止を要求しました"
      } else {
        Log "$id は $state です"
      }
    }
    'status' { Show-Status (Get-InstanceId) }
    'ssh' {
      Start-Remote (Get-InstanceId)
      & ssh $HostAlias @Rest
      exit $LASTEXITCODE
    }
    { $_ -in 'shell', 'tmux' } {
      # 既定の ssm-user ではなく、Claude Code を入れてある ec2-user のログインシェルで開く
      $remoteCommand = 'sudo -iu ec2-user'
      if ($Command -eq 'tmux') {
        $session = if ($Rest.Count -gt 0) { $Rest[0] } else { 'main' }
        # リモートのシェルにそのまま渡るので、使える文字を絞る（tmux はセッション名の . と : を受け付けない）
        if ($session -notmatch '^[A-Za-z0-9_-]+$') { throw "セッション名に使えるのは英数字、_、- だけです: $session" }
        $remoteCommand += " tmux new -As $session"
      }
      $id = Get-InstanceId
      Start-Remote $id
      & aws ssm start-session --target $id --region $Region `
        --document-name AWS-StartInteractiveCommand --parameters "command=$remoteCommand"
      exit $LASTEXITCODE
    }
    'ssh-config' { Show-SshConfig (Get-InstanceId) }
    'proxy' {
      if ($Rest.Count -lt 1) { throw 'usage: remote.ps1 proxy <instance-id> [port]' }
      $id = $Rest[0]
      $port = if ($Rest.Count -gt 1) { $Rest[1] } else { '22' }
      Start-Remote $id
      & aws ssm start-session --target $id --document-name AWS-StartSSHSession `
        --parameters "portNumber=$port" --region $Region
      exit $LASTEXITCODE
    }
    default {
      (Get-Content $PSCommandPath -TotalCount 17 -Encoding UTF8 | Select-Object -Skip 1) -join "`n"
      if ($Command -ne 'help') { exit 1 }
    }
  }
} catch {
  Log "エラー: $($_.Exception.Message)"
  exit 1
}
