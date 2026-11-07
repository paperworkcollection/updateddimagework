plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

android {
    namespace = "com.paperwork.mobile"
    compileSdk = 35
    defaultConfig { applicationId = "com.paperwork.mobile"; minSdk = 24; targetSdk = 35; versionCode = 1; versionName = "1.0.0" }

    // Keep Java and Kotlin bytecode targets aligned to avoid JVM target mismatch.
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}
