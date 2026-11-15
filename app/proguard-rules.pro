# Mayhem on Android — R8 rules.
# Keep readable crash traces.
-keepattributes SourceFile,LineNumberTable
# JNI entry points (name-bound from native code) — none yet; kept for when a USB-reset shim lands.
-keepclasseswithmembernames class * {
    native <methods>;
}

# Crash reports go to the developer by email as plain text (CrashReport.kt), so stack traces must read as written:
# keep class and method names and file names. Shrinking and optimization still run.
-dontobfuscate

