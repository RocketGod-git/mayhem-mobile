# Mayhem on Android — R8 rules.
# Keep readable crash traces.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
# JNI entry points (name-bound from native code) — none yet; kept for when a USB-reset shim lands.
-keepclasseswithmembernames class * {
    native <methods>;
}
