// AGP 9 compiles Kotlin itself and only pins a minimum Kotlin Gradle plugin; the classpath entry below raises it.
// The Compose compiler plugin must carry the same Kotlin version, so the two move together.
buildscript {
    dependencies {
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21")
    }
}
plugins {
    id("com.android.application") version "9.4.1" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
}
