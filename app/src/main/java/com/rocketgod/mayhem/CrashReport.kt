package com.rocketgod.mayhem

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Crash reports. When the app dies on an uncaught exception, [install]'s handler writes what happened to a file (the
 * exception and its stack, the screen that was open, the app and device header, and the tail of [Diag]) and then lets
 * Android close the app as usual. On the next launch [pending] finds it, and the user can send it to the developer by
 * email, save it to Downloads, or dismiss it.
 */
object CrashReport {
    const val DEV_EMAIL = "RocketGod666@gmail.com"
    private const val LOG_TAIL = 300
    private val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US)

    private fun file(ctx: Context) = File(File(ctx.filesDir, "crash").apply { mkdirs() }, "pending.txt")

    /** Called first thing at startup; keeps whatever handler was there (the system's) and runs it afterwards. */
    fun install(ctx: Context) {
        val app = ctx.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching { file(app).writeText(report(thread, error)) }
            previous?.uncaughtException(thread, error)
        }
    }

    private fun report(thread: Thread, error: Throwable): String {
        val trace = StringWriter().also { error.printStackTrace(PrintWriter(it)) }.toString()
        val screen = runCatching { com.rocketgod.mayhem.core.Apps.current.value?.name ?: "home" }.getOrDefault("?")
        val log = runCatching { Diag.lines.value.takeLast(LOG_TAIL) }.getOrDefault(emptyList())
        var root = error
        while (root.cause != null && root.cause !== root) root = root.cause!!
        return buildString {
            appendLine("Mayhem closed unexpectedly")
            appendLine("Error ${root.javaClass.simpleName}${root.message?.let { ": " + it.lineSequence().first().take(140) } ?: ""}")
            Diag.header().forEach { appendLine(it) }
            appendLine("Screen $screen · thread ${thread.name}")
            appendLine("Crashed ${SimpleDateFormat("yyyy-MM-dd HH:mm:ss z", Locale.US).format(Date())}")
            appendLine()
            appendLine(trace.trimEnd())
            appendLine()
            appendLine("--- last ${log.size} log lines ---")
            log.forEach { appendLine(it) }
        }
    }

    /** The report from a crash since the last launch, if there is one. */
    fun pending(ctx: Context): String? = runCatching { file(ctx).takeIf { it.exists() }?.readText() }.getOrNull()

    fun clear(ctx: Context) { runCatching { file(ctx).delete() } }

    /** "NullPointerException: something": the root cause, as written into the report when it crashed. */
    fun headline(report: String): String =
        report.lineSequence().firstOrNull { it.startsWith("Error ") }?.removePrefix("Error ") ?: "unknown error"

    /** An email to the developer with the report in the body and attached as a file, offered only to email apps. */
    fun sendIntent(ctx: Context, report: String): Intent {
        val dir = File(ctx.cacheDir, "logs").apply { mkdirs() }
        val f = File(dir, "mayhem-crash-${stamp.format(Date())}.txt").apply { writeText(report) }
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.logs", f)
        val subject = "Mayhem Mobile crash · ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) · ${headline(report)}".take(180)
        // an email app opens its composer straight away, addressed and filled in (the whole report is the body)
        val mail = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:")).apply {
            putExtra(Intent.EXTRA_EMAIL, arrayOf(DEV_EMAIL))
            putExtra(Intent.EXTRA_SUBJECT, subject)
            putExtra(Intent.EXTRA_TEXT, report)
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        if (ctx.packageManager.queryIntentActivities(mail, 0).isNotEmpty()) return mail
        // no email app: the share sheet, so the report can still go out (messaging, cloud storage, anything)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_EMAIL, arrayOf(DEV_EMAIL))
            putExtra(Intent.EXTRA_SUBJECT, subject)
            putExtra(Intent.EXTRA_TEXT, report)
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return Intent.createChooser(send, "Send crash report")
    }

    /** Saves the report to Downloads (Android 10+), else to the app's own external files; returns where, or null. */
    fun save(ctx: Context, report: String): String? = runCatching {
        val name = "mayhem-crash-${stamp.format(Date())}.txt"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, "text/plain")
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            }
            val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return null
            ctx.contentResolver.openOutputStream(uri)?.use { it.write(report.toByteArray()) } ?: return null
            "Downloads/$name"
        } else {
            val f = File(ctx.getExternalFilesDir(null), name).apply { writeText(report) }
            f.absolutePath
        }
    }.getOrNull()
}
