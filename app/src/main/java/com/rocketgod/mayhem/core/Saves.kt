package com.rocketgod.mayhem.core

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.ByteArrayOutputStream
import java.io.File

/** Files the user keeps: logbook exports and decoded pictures, into Downloads (or Pictures) where they can find them. */
object Saves {
    /** Returns where it went ("Downloads/name"), or null on failure. Needs no permission on Android 10+. */
    fun toDownloads(ctx: Context, name: String, mime: String, bytes: ByteArray, pictures: Boolean = false): String? = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val dir = if (pictures) Environment.DIRECTORY_PICTURES else Environment.DIRECTORY_DOWNLOADS
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, dir)
            }
            val coll = if (pictures) MediaStore.Images.Media.EXTERNAL_CONTENT_URI else MediaStore.Downloads.EXTERNAL_CONTENT_URI
            val uri = ctx.contentResolver.insert(coll, values) ?: return@runCatching null
            ctx.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
            "$dir/$name"
        } else {
            val f = File(ctx.getExternalFilesDir(null), name)
            f.writeBytes(bytes)
            f.path
        }
    }.getOrNull()

    fun png(bmp: Bitmap): ByteArray = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()

    fun stamp(): String = java.text.SimpleDateFormat("yyyy-MM-dd-HHmmss", java.util.Locale.US).format(java.util.Date())
}
