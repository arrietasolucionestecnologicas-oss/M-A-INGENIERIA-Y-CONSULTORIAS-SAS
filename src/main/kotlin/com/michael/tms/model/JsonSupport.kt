package com.michael.tms.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

object JsonSupport {
    val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        prettyPrint = false
    }
}

fun <T> T.toJsonElement(serializer: KSerializer<T>): JsonElement =
    JsonSupport.json.encodeToJsonElement(serializer, this)

fun <T> JsonElement.toDto(serializer: KSerializer<T>): T =
    JsonSupport.json.decodeFromJsonElement(serializer, this)
