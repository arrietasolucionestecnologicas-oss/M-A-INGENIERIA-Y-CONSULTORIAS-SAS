package com.michael.tms.db

import org.jetbrains.exposed.dao.id.UUIDTable
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.javatime.date
import org.jetbrains.exposed.sql.javatime.datetime
import java.time.LocalDateTime

object Tenants : UUIDTable("tenants") {
    val companyName = varchar("company_name", 255)
    val taxId = varchar("tax_id", 50).nullable()
    val isActive = bool("is_active").default(true)
    val plan = varchar("plan", 20).default("BASIC")
    val maxUsers = integer("max_users").default(20)
    val subscriptionExpiresAt = datetime("subscription_expires_at").nullable()
    val createdAt = datetime("created_at").clientDefault { LocalDateTime.now() }
    val updatedAt = datetime("updated_at").clientDefault { LocalDateTime.now() }
}

object AdminTokens : UUIDTable("admin_tokens") {
    val tokenHash = varchar("token_hash", 255)
    val description = varchar("description", 255).nullable()
    val isActive = bool("is_active").default(true)
    val createdAt = datetime("created_at").clientDefault { LocalDateTime.now() }
}

object Users : UUIDTable("users") {
    val tenantId = reference("tenant_id", Tenants)
    val email = varchar("email", 255)
    val passwordHash = varchar("password_hash", 255)
    val fullName = varchar("full_name", 255)
    val role = varchar("role", 20)
    val licenseNumber = varchar("license_number", 100).nullable()
    val isActive = bool("is_active").default(true)
    val createdAt = datetime("created_at").clientDefault { LocalDateTime.now() }
    val updatedAt = datetime("updated_at").clientDefault { LocalDateTime.now() }

    init {
        uniqueIndex("uq_users_tenant_email", tenantId, email)
    }
}

object ClientSites : UUIDTable("client_sites") {
    val tenantId = reference("tenant_id", Tenants)
    val clientName = varchar("client_name", 255)
    val siteName = varchar("site_name", 255)
    val address = varchar("address", 500).nullable()
    val latitude = double("latitude").nullable()
    val longitude = double("longitude").nullable()
    val createdAt = datetime("created_at").clientDefault { LocalDateTime.now() }
    val updatedAt = datetime("updated_at").clientDefault { LocalDateTime.now() }
}

/**
 * Catálogo normativo de grupos de conexión vectoriales, tabla global (no tenant-scoped).
 * ratioMultiplier es el factor que relaciona la razón de transformación línea-línea con la
 * razón fase-fase, según la topología Delta/Estrella de cada devanado (ej. sqrt(3) para Dyn).
 */
object VectorGroupReference : Table("vector_group_reference") {
    val code = varchar("code", 20)
    val windingConfig = varchar("winding_config", 50)
    val phaseShiftDegrees = integer("phase_shift_degrees").nullable()
    val ratioMultiplier = double("ratio_multiplier")
    val isActive = bool("is_active").default(true)
    override val primaryKey = PrimaryKey(code)
}

object Transformers : UUIDTable("transformers") {
    val tenantId = reference("tenant_id", Tenants)
    val siteId = reference("site_id", ClientSites)
    val serialNumber = varchar("serial_number", 100)
    val manufacturer = varchar("manufacturer", 255).nullable()
    val manufactureYear = integer("manufacture_year").nullable()
    val phaseType = varchar("phase_type", 20)
    val vectorGroup = varchar("vector_group", 20).nullable()
    val ratedPowerKva = double("rated_power_kva").nullable()
    val coolingType = varchar("cooling_type", 50).nullable()
    val hvNominalVoltage = double("hv_nominal_voltage")
    val lvNominalVoltage = double("lv_nominal_voltage")
    val tapConfig = jsonb("tap_config")
    val isSpecialDesign = bool("is_special_design").default(false)
    val customTapRatioMatrix = jsonb("custom_tap_ratio_matrix").nullable()
    val status = varchar("status", 20).default("ACTIVO")
    val createdAt = datetime("created_at").clientDefault { LocalDateTime.now() }
    val updatedAt = datetime("updated_at").clientDefault { LocalDateTime.now() }
}

object TestSessions : UUIDTable("test_sessions") {
    val tenantId = reference("tenant_id", Tenants)
    val transformerId = reference("transformer_id", Transformers)
    val testDate = date("test_date")
    val responsibleUserId = reference("responsible_user_id", Users)
    val ambientTemperatureC = double("ambient_temperature_c").nullable()
    val relativeHumidityPct = double("relative_humidity_pct").nullable()
    val sessionStatus = varchar("session_status", 20).default("BORRADOR")
    val generalNotes = text("general_notes").nullable()
    val createdAt = datetime("created_at").clientDefault { LocalDateTime.now() }
    val updatedAt = datetime("updated_at").clientDefault { LocalDateTime.now() }
}

/**
 * Tabla polimórfica híbrida relacional/documental: metadata en columnas relacionales,
 * lecturas crudas y resultados calculados en JSONB. applied_theoretical_ratio (dentro de
 * calculated_results) queda congelado permanentemente en el momento del cálculo: nunca se
 * recalcula si luego cambia custom_tap_ratio_matrix en el transformador.
 */
object TestResults : UUIDTable("test_results") {
    val tenantId = reference("tenant_id", Tenants)
    val testSessionId = reference("test_session_id", TestSessions)
    val testType = varchar("test_type", 30)
    val rawReadings = jsonb("raw_readings")
    val calculatedResults = jsonb("calculated_results")
    val verdict = varchar("verdict", 20)
    val instrumentUsed = varchar("instrument_used", 255).nullable()
    val testedBy = reference("tested_by", Users)
    val createdAt = datetime("created_at").clientDefault { LocalDateTime.now() }
}

object Attachments : UUIDTable("attachments") {
    val tenantId = reference("tenant_id", Tenants)
    val testSessionId = reference("test_session_id", TestSessions).nullable()
    val transformerId = reference("transformer_id", Transformers).nullable()
    val fileUrl = varchar("file_url", 1000)
    val attachmentType = varchar("attachment_type", 30)
    val createdAt = datetime("created_at").clientDefault { LocalDateTime.now() }
}

/**
 * Trazabilidad obligatoria para campos de alta criticidad (datos de placa y
 * custom_tap_ratio_matrix del transformador). Un registro por campo modificado.
 */
object AuditLog : UUIDTable("audit_log") {
    val tenantId = reference("tenant_id", Tenants)
    val entityType = varchar("entity_type", 50)
    val entityId = varchar("entity_id", 100)
    val field = varchar("field", 100)
    val oldValue = text("old_value").nullable()
    val newValue = text("new_value").nullable()
    val changedBy = reference("changed_by", Users)
    val changedAt = datetime("changed_at").clientDefault { LocalDateTime.now() }
}
