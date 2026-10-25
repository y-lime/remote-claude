import * as cdk from 'aws-cdk-lib/core';
import * as codeartifact from 'aws-cdk-lib/aws-codeartifact';
import { Construct } from 'constructs';

export interface ArtifactsStackProps extends cdk.StackProps {
  readonly domainName: string;
  /** Gradle が見るリポジトリ。自分たちのライブラリもここに publish する */
  readonly repositoryName: string;
}

/**
 * Gradle 用の CodeArtifact。EC2 のスタックを作り直してもライブラリが残るよう、別スタックにして RETAIN にする。
 * 外部接続は1リポジトリに1つしか付けられないので、Maven Central と Gradle Plugin Portal は別のリポジトリにして上流につなぐ。
 */
export class ArtifactsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ArtifactsStackProps) {
    super(scope, id, props);

    const domain = new codeartifact.CfnDomain(this, 'Domain', { domainName: props.domainName });
    domain.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    const store = (logicalId: string, repositoryName: string, externalConnection: string) => {
      const repo = new codeartifact.CfnRepository(this, logicalId, {
        domainName: domain.attrName,
        repositoryName,
        externalConnections: [externalConnection],
        description: `${externalConnection} のキャッシュ`,
      });
      repo.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
      return repo;
    };
    const mavenCentral = store('MavenCentralStore', 'maven-central-store', 'public:maven-central');
    const gradlePlugins = store('GradlePluginsStore', 'gradle-plugins-store', 'public:maven-gradleplugins');

    // 上流は書いた順に探す
    const libs = new codeartifact.CfnRepository(this, 'Libs', {
      domainName: domain.attrName,
      repositoryName: props.repositoryName,
      upstreams: [mavenCentral.attrName, gradlePlugins.attrName],
      description: 'Gradle が見るリポジトリ。自分たちのライブラリもここに publish する',
    });
    libs.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    new cdk.CfnOutput(this, 'DomainName', { value: domain.attrName });
    new cdk.CfnOutput(this, 'RepositoryName', { value: libs.attrName });
  }
}
