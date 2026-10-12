// This exact AGP / Kotlin / Compose combination is the one proven on GitHub runners.
// Bump all three Kotlin-side versions together.
plugins {
    id("com.android.application") version "8.6.1" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    // Kotlin 2.0's Compose compiler lives in its own Gradle plugin; its version must match the Kotlin version.
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
}
