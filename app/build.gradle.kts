val BASE_VERSION_CODE = 15

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.rocketgod.mayhem"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.rocketgod.mayhem"
        minSdk = 26
        targetSdk = 37
        // The Play workflow overrides this with VERSION_CODE, resolved from the highest code
        // Play already knows about, so an API upload can never collide with a Console one.
        // BASE_VERSION_CODE stays a plain literal because the release workflow reads it with sed.
        versionCode = System.getenv("VERSION_CODE")?.toIntOrNull() ?: BASE_VERSION_CODE
        versionName = "0.6.7"
        vectorDrawables { useSupportLibrary = true }
        // Short commit hash stamped by CI (GITHUB_SHA) so the APK and the web app can prove they are the same build.
        buildConfigField("String", "GIT_SHA", "\"${System.getenv("GITHUB_SHA")?.take(7) ?: "local"}\"")
    }

    signingConfigs {
        create("release") {
            // Release signing comes ONLY from the environment (CI secrets → env vars). Nothing is committed:
            //   ANDROID_KEYSTORE_PATH      path to the keystore materialized from the ANDROID_KEYSTORE_B64 secret
            //   ANDROID_KEYSTORE_PASSWORD  store password
            //   ANDROID_KEY_ALIAS          key alias (default "mayhem")
            //   ANDROID_KEY_PASSWORD       key password (defaults to the store password)
            // GitHub Actions passes unset secrets as EMPTY strings, hence isNotBlank() rather than a null check.
            fun env(name: String) = System.getenv(name)?.takeIf { it.isNotBlank() }
            val ksPath = env("ANDROID_KEYSTORE_PATH")
            if (ksPath != null) {
                storeFile = file(ksPath)
                storePassword = env("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = env("ANDROID_KEY_ALIAS") ?: "mayhem"
                keyPassword = env("ANDROID_KEY_PASSWORD") ?: env("ANDROID_KEYSTORE_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            // R8 shrinks and obfuscates; the mapping rides inside the bundle, so Play de-obfuscates crash traces.
            isMinifyEnabled = true
            isShrinkResources = true
            // Native libraries come from dependencies; their symbol tables go into the bundle for Play's crash reports.
            ndk { debugSymbolLevel = "FULL" }
            // Signed with the release keystore when the env vars above are present (the release workflow);
            // otherwise fall back to the debug key so `assembleRelease` still yields an installable APK.
            signingConfig = if (System.getenv("ANDROID_KEYSTORE_PATH").isNullOrBlank())
                signingConfigs.getByName("debug") else signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true; buildConfig = true }
    // Android framework calls answer with defaults under the JVM tests, so the singletons can be initialised there.
    testOptions { unitTests.isReturnDefaultValues = true }
    packaging { resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" } }
}

dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("org.osmdroid:osmdroid-android:6.1.20")
    // Play in-app updates: a Play-installed build may not fetch its own APK, so the update has to be
    // handed to Play. Unused by sideloads, which check GitHub instead (see AppUpdates).
    implementation("com.google.android.play:app-update-ktx:2.1.0")

    val composeBom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814")
}
