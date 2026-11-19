# Capacitor core + plugins (release R8)
-keep class com.getcapacitor.** { *; }
-keep class com.capacitorjs.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * {
    @com.getcapacitor.annotation.CapacitorPlugin <methods>;
}
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Optional / reflective plugin references — do not fail release minify
-dontwarn com.getcapacitor.**
-dontwarn com.capacitorjs.**
-dontwarn com.capacitorjs.plugins.**
-dontwarn com.capacitorjs.plugins.splashscreen.**

# AndroidX SplashScreen + WebView helpers used by Capacitor shell
-keep class androidx.core.splashscreen.** { *; }
-dontwarn androidx.core.splashscreen.**
-keep class androidx.webkit.** { *; }
-dontwarn androidx.webkit.**

# Firebase (push) — keep init providers/services
-keep class com.google.firebase.** { *; }
-dontwarn com.google.firebase.**

-keepattributes SourceFile,LineNumberTable,*Annotation*
-renamesourcefileattribute SourceFile
