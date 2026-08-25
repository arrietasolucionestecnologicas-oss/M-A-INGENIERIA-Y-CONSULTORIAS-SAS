package com.michael.tms.db

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import org.jetbrains.exposed.sql.ColumnType
import org.jetbrains.exposed.sql.Table
import org.postgresql.util.PGobject

/**
 * Columna JSONB nativa de PostgreSQL, mapeada a kotlinx.serialization.json.JsonElement.
 * Las estructuras dinámicas (lecturas y resultados calculados de cada tipo de prueba,
 * matriz de TAPs personalizada, tap_config) se serializan/deserializan a nivel de servicio
 * usando los data classes correspondientes en el paquete model.
 */
class JsonbColumnType : ColumnType() {
    override fun sqlType(): String = "JSONB"

    override fun valueFromDB(value: Any): Any = when (value) {
        is PGobject -> value.value?.let { Json.parseToJsonElement(it) } ?: JsonNull
        is String -> Json.parseToJsonElement(value)
        else -> value
    }

    override fun notNullValueToDB(value: Any): Any {
        val json = value as? JsonElement ?: error("Se esperaba un JsonElement para columna JSONB")
        return PGobject().apply {
            type = "jsonb"
            this.value = json.toString()
        }
    }

    override fun nonNullValueToString(value: Any): String {
        val json = value as? JsonElement ?: error("Se esperaba un JsonElement para columna JSONB")
        return "'${json}'::jsonb"
    }
}

fun Table.jsonb(name: String): org.jetbrains.exposed.sql.Column<JsonElement> =
    registerColumn(name, JsonbColumnType())
