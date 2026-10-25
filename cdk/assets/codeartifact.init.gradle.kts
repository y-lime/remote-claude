// remote-claude: 依存ライブラリと Gradle プラグインを CodeArtifact から取る。
// CODEARTIFACT_* の環境変数（/etc/remote-claude/claude.env）がなければ何もしない。
// build.gradle(.kts) に書いた repositories は使わない（PREFER_SETTINGS）。Maven Central などは CodeArtifact の上流から取る

val caUrl = System.getenv("CODEARTIFACT_URL").orEmpty()
val caDomain = System.getenv("CODEARTIFACT_DOMAIN").orEmpty()
val caOwner = System.getenv("CODEARTIFACT_DOMAIN_OWNER").orEmpty()

fun RepositoryHandler.codeArtifact(token: String) {
    maven {
        name = "codeartifact"
        url = java.net.URI(caUrl)
        credentials {
            username = "aws"
            password = token
        }
    }
}

if (caUrl.isNotBlank() && caDomain.isNotBlank() && caOwner.isNotBlank()) {
    // トークンの有効期限は最長12時間なので、ビルドのたびに取る（buildSrc などで settings が複数あっても1回だけ）
    var token: String? = null
    beforeSettings {
        val t = token ?: providers.exec {
            commandLine(
                "aws", "codeartifact", "get-authorization-token",
                "--domain", caDomain, "--domain-owner", caOwner,
                "--query", "authorizationToken", "--output", "text",
            )
        }.standardOutput.asText.get().trim().also { token = it }

        pluginManagement {
            repositories { codeArtifact(t) }
        }
        dependencyResolutionManagement {
            repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
            repositories { codeArtifact(t) }
        }
    }
}
