package com.michael.tms.service

import com.michael.tms.db.ClientSites
import com.michael.tms.db.Tenants
import com.michael.tms.db.Transformers
import com.michael.tms.db.VectorGroupReference
import com.michael.tms.db.toEntityId
import com.michael.tms.model.CreateTransformerRequest
import com.michael.tms.model.CustomTapRatioMatrix
import com.michael.tms.model.PhaseType
import com.michael.tms.model.TapConfig
import com.michael.tms.model.TransformerResponse
import com.michael.tms.model.TransformerStatus
import com.michael.tms.model.UpdateTransformerRequest
import com.michael.tms.model.toDto
import com.michael.tms.model.toJsonElement
import com.michael.tms.security.BadRequestException
import com.michael.tms.security.NotFoundException
import com.michael.tms.service.calc.TransformerCalcContext
import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.eq
import org.jetbrains.exposed.sql.insertAndGetId
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import org.jetbrains.exposed.sql.update
import java.time.LocalDateTime
import java.util.UUID

object TransformerService {

    fun create(tenantId: UUID, request: CreateTransformerRequest): TransformerResponse = transaction {
        val siteId = UUID.fromString(request.siteId)
        SiteService.fetchRow(tenantId, siteId)

        validateProfile(request.phaseType, request.vectorGroup, request.tapConfig, request.isSpecialDesign, request.customTapRatioMatrix)

        val id = Transformers.insertAndGetId {
            it[Transformers.tenantId] = tenantId.toEntityId(Tenants)
            it[Transformers.siteId] = siteId.toEntityId(ClientSites)
            it[serialNumber] = request.serialNumber
            it[manufacturer] = request.manufacturer
            it[manufactureYear] = request.manufactureYear
            it[phaseType] = request.phaseType.name
            it[vectorGroup] = request.vectorGroup
            it[ratedPowerKva] = request.ratedPowerKva
            it[coolingType] = request.coolingType
            it[hvNominalVoltage] = request.hvNominalVoltage
            it[lvNominalVoltage] = request.lvNominalVoltage
            it[tapConfig] = request.tapConfig.toJsonElement(TapConfig.serializer())
            it[isSpecialDesign] = request.isSpecialDesign
            it[customTapRatioMatrix] = request.customTapRatioMatrix?.toJsonElement(CustomTapRatioMatrix.serializer())
            it[status] = TransformerStatus.ACTIVO.name
        }
        toResponse(fetchRow(tenantId, id.value))
    }

    fun list(tenantId: UUID, siteId: UUID? = null): List<TransformerResponse> = transaction {
        val query = if (siteId != null) {
            Transformers.selectAll().where { (Transformers.tenantId eq tenantId) and (Transformers.siteId eq siteId) }
        } else {
            Transformers.selectAll().where { Transformers.tenantId eq tenantId }
        }
        query.map { toResponse(it) }
    }

    fun get(tenantId: UUID, id: UUID): TransformerResponse = transaction {
        toResponse(fetchRow(tenantId, id))
    }

    /**
     * PATCH de perfil de transformador (datos de placa + tap_config + custom_tap_ratio_matrix).
     * Reservado a roles SUPERVISOR/ADMINISTRADOR a nivel de ruta. La validación de consistencia
     * se ejecuta sobre el estado ya fusionado (existente + cambios), no de forma parcial, y cada
     * campo crítico modificado queda registrado en audit_log.
     */
    fun update(tenantId: UUID, id: UUID, request: UpdateTransformerRequest, actorId: UUID): TransformerResponse = transaction {
        val existing = fetchRow(tenantId, id)

        val newSiteId = request.siteId?.let { UUID.fromString(it) } ?: existing[Transformers.siteId].value
        if (request.siteId != null) SiteService.fetchRow(tenantId, newSiteId)

        val newSerialNumber = request.serialNumber ?: existing[Transformers.serialNumber]
        val newManufacturer = request.manufacturer ?: existing[Transformers.manufacturer]
        val newManufactureYear = request.manufactureYear ?: existing[Transformers.manufactureYear]
        val newPhaseType = request.phaseType ?: PhaseType.valueOf(existing[Transformers.phaseType])
        val newVectorGroup = if (request.clearVectorGroup) null else (request.vectorGroup ?: existing[Transformers.vectorGroup])
        val newRatedPowerKva = request.ratedPowerKva ?: existing[Transformers.ratedPowerKva]
        val newCoolingType = request.coolingType ?: existing[Transformers.coolingType]
        val newHvNominalVoltage = request.hvNominalVoltage ?: existing[Transformers.hvNominalVoltage]
        val newLvNominalVoltage = request.lvNominalVoltage ?: existing[Transformers.lvNominalVoltage]
        val existingTapConfig = existing[Transformers.tapConfig].toDto(TapConfig.serializer())
        val newTapConfig = request.tapConfig ?: existingTapConfig
        val newIsSpecialDesign = request.isSpecialDesign ?: existing[Transformers.isSpecialDesign]
        val existingMatrix = existing[Transformers.customTapRatioMatrix]?.toDto(CustomTapRatioMatrix.serializer())
        val newCustomMatrix = request.customTapRatioMatrix ?: existingMatrix
        val newStatus = request.status ?: TransformerStatus.valueOf(existing[Transformers.status])

        validateProfile(newPhaseType, newVectorGroup, newTapConfig, newIsSpecialDesign, newCustomMatrix)

        val oldTapConfigJson = existing[Transformers.tapConfig].toString()
        val newTapConfigJson = newTapConfig.toJsonElement(TapConfig.serializer()).toString()
        val oldMatrixJson = existing[Transformers.customTapRatioMatrix]?.toString()
        val newMatrixJson = newCustomMatrix?.toJsonElement(CustomTapRatioMatrix.serializer())?.toString()

        Transformers.update({ (Transformers.tenantId eq tenantId) and (Transformers.id eq id) }) { stmt ->
            stmt[Transformers.siteId] = newSiteId.toEntityId(ClientSites)
            stmt[serialNumber] = newSerialNumber
            stmt[manufacturer] = newManufacturer
            stmt[manufactureYear] = newManufactureYear
            stmt[phaseType] = newPhaseType.name
            stmt[vectorGroup] = newVectorGroup
            stmt[ratedPowerKva] = newRatedPowerKva
            stmt[coolingType] = newCoolingType
            stmt[hvNominalVoltage] = newHvNominalVoltage
            stmt[lvNominalVoltage] = newLvNominalVoltage
            stmt[tapConfig] = newTapConfig.toJsonElement(TapConfig.serializer())
            stmt[isSpecialDesign] = newIsSpecialDesign
            stmt[customTapRatioMatrix] = newCustomMatrix?.toJsonElement(CustomTapRatioMatrix.serializer())
            stmt[status] = newStatus.name
            stmt[updatedAt] = LocalDateTime.now()
        }

        AuditService.recordChanges(
            tenantId = tenantId,
            entityType = "TRANSFORMER",
            entityId = id,
            changedBy = actorId,
            changes = mapOf(
                "site_id" to (existing[Transformers.siteId].value.toString() to newSiteId.toString()),
                "serial_number" to (existing[Transformers.serialNumber] to newSerialNumber),
                "manufacturer" to (existing[Transformers.manufacturer] to newManufacturer),
                "manufacture_year" to (existing[Transformers.manufactureYear]?.toString() to newManufactureYear?.toString()),
                "phase_type" to (existing[Transformers.phaseType] to newPhaseType.name),
                "vector_group" to (existing[Transformers.vectorGroup] to newVectorGroup),
                "rated_power_kva" to (existing[Transformers.ratedPowerKva]?.toString() to newRatedPowerKva?.toString()),
                "cooling_type" to (existing[Transformers.coolingType] to newCoolingType),
                "hv_nominal_voltage" to (existing[Transformers.hvNominalVoltage].toString() to newHvNominalVoltage.toString()),
                "lv_nominal_voltage" to (existing[Transformers.lvNominalVoltage].toString() to newLvNominalVoltage.toString()),
                "tap_config" to (oldTapConfigJson to newTapConfigJson),
                "is_special_design" to (existing[Transformers.isSpecialDesign].toString() to newIsSpecialDesign.toString()),
                "custom_tap_ratio_matrix" to (oldMatrixJson to newMatrixJson),
                "status" to (existing[Transformers.status] to newStatus.name)
            )
        )

        toResponse(fetchRow(tenantId, id))
    }

    /** Baja lógica del equipo (status = BAJA). No se borra el registro ni su historial de pruebas. */
    fun deactivate(tenantId: UUID, id: UUID, actorId: UUID): TransformerResponse = transaction {
        val existing = fetchRow(tenantId, id)
        val previousStatus = existing[Transformers.status]

        Transformers.update({ (Transformers.tenantId eq tenantId) and (Transformers.id eq id) }) {
            it[status] = TransformerStatus.BAJA.name
            it[updatedAt] = LocalDateTime.now()
        }

        AuditService.recordChanges(
            tenantId = tenantId,
            entityType = "TRANSFORMER",
            entityId = id,
            changedBy = actorId,
            changes = mapOf("status" to (previousStatus to TransformerStatus.BAJA.name))
        )

        toResponse(fetchRow(tenantId, id))
    }

    fun fetchRow(tenantId: UUID, id: UUID): ResultRow =
        Transformers.selectAll().where { (Transformers.tenantId eq tenantId) and (Transformers.id eq id) }.singleOrNull()
            ?: throw NotFoundException("Transformador no encontrado: $id")

    fun toCalcContext(row: ResultRow): TransformerCalcContext = TransformerCalcContext(
        id = row[Transformers.id].value,
        phaseType = PhaseType.valueOf(row[Transformers.phaseType]),
        vectorGroup = row[Transformers.vectorGroup],
        isSpecialDesign = row[Transformers.isSpecialDesign],
        tapConfig = row[Transformers.tapConfig].toDto(TapConfig.serializer()),
        customTapRatioMatrix = row[Transformers.customTapRatioMatrix]?.toDto(CustomTapRatioMatrix.serializer()),
        lvNominalVoltage = row[Transformers.lvNominalVoltage]
    )

    private fun validateProfile(
        phaseType: PhaseType,
        vectorGroup: String?,
        tapConfig: TapConfig,
        isSpecialDesign: Boolean,
        customMatrix: CustomTapRatioMatrix?
    ) {
        if (tapConfig.positions.isEmpty()) {
            throw BadRequestException("tap_config debe incluir al menos una posición de TAP")
        }
        if (tapConfig.positions.size != tapConfig.numPositions) {
            throw BadRequestException(
                "tap_config.numPositions (${tapConfig.numPositions}) no coincide con la cantidad de " +
                    "posiciones enviadas (${tapConfig.positions.size})"
            )
        }
        if (phaseType == PhaseType.MONOFASICO && vectorGroup != null && vectorGroup != "CUSTOM") {
            throw BadRequestException(
                "Un transformador monofásico no admite el grupo de conexión '$vectorGroup' (solo null o CUSTOM)"
            )
        }

        val usesCustomMatrix = isSpecialDesign || vectorGroup == "CUSTOM"
        if (usesCustomMatrix) {
            validateCustomMatrixCoverage(tapConfig, customMatrix)
        } else if (vectorGroup != null) {
            val exists = VectorGroupReference.selectAll()
                .where { (VectorGroupReference.code eq vectorGroup) and (VectorGroupReference.isActive eq true) }
                .count() > 0
            if (!exists) throw BadRequestException("Grupo de conexión desconocido o inactivo: $vectorGroup")
        }
    }

    private fun validateCustomMatrixCoverage(tapConfig: TapConfig, matrix: CustomTapRatioMatrix?) {
        if (matrix == null) {
            throw BadRequestException(
                "custom_tap_ratio_matrix es obligatoria para equipos con diseño especial o grupo CUSTOM"
            )
        }
        val required = tapConfig.positions.map { it.position }.toSet()
        val covered = matrix.taps.map { it.tapPosition }.toSet()
        val missing = required - covered
        if (missing.isNotEmpty()) {
            throw BadRequestException("custom_tap_ratio_matrix incompleta: faltan posiciones de TAP $missing")
        }
        matrix.taps.forEach { tap ->
            if (tap.phases.isEmpty()) {
                throw BadRequestException("custom_tap_ratio_matrix: el TAP ${tap.tapPosition} no tiene fases definidas")
            }
        }
    }

    private fun toResponse(row: ResultRow) = TransformerResponse(
        id = row[Transformers.id].value.toString(),
        siteId = row[Transformers.siteId].value.toString(),
        serialNumber = row[Transformers.serialNumber],
        manufacturer = row[Transformers.manufacturer],
        manufactureYear = row[Transformers.manufactureYear],
        phaseType = row[Transformers.phaseType],
        vectorGroup = row[Transformers.vectorGroup],
        ratedPowerKva = row[Transformers.ratedPowerKva],
        coolingType = row[Transformers.coolingType],
        hvNominalVoltage = row[Transformers.hvNominalVoltage],
        lvNominalVoltage = row[Transformers.lvNominalVoltage],
        tapConfig = row[Transformers.tapConfig].toDto(TapConfig.serializer()),
        isSpecialDesign = row[Transformers.isSpecialDesign],
        customTapRatioMatrix = row[Transformers.customTapRatioMatrix]?.toDto(CustomTapRatioMatrix.serializer()),
        status = row[Transformers.status],
        createdAt = row[Transformers.createdAt].iso(),
        updatedAt = row[Transformers.updatedAt].iso()
    )
}
