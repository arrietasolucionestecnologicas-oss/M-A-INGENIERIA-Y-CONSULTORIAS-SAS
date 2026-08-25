package com.michael.tms.service

import com.michael.tms.db.AuditLog
import com.michael.tms.db.toEntityId
import com.michael.tms.db.Tenants
import com.michael.tms.db.Users
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.transactions.transaction
import java.time.LocalDateTime
import java.util.UUID

object AuditService {
    /**
     * Registra un renglón de auditoría por cada campo cuyo valor textual haya cambiado.
     * Debe invocarse dentro de la misma transacción que persiste el cambio de negocio,
     * para que ambos queden atómicamente consistentes.
     */
    fun recordChanges(
        tenantId: UUID,
        entityType: String,
        entityId: UUID,
        changedBy: UUID,
        changes: Map<String, Pair<String?, String?>>
    ) {
        changes.forEach { (field, oldNew) ->
            val (oldValue, newValue) = oldNew
            if (oldValue != newValue) {
                AuditLog.insert {
                    it[AuditLog.tenantId] = tenantId.toEntityId(Tenants)
                    it[AuditLog.entityType] = entityType
                    it[AuditLog.entityId] = entityId.toString()
                    it[AuditLog.field] = field
                    it[AuditLog.oldValue] = oldValue
                    it[AuditLog.newValue] = newValue
                    it[AuditLog.changedBy] = changedBy.toEntityId(Users)
                    it[AuditLog.changedAt] = LocalDateTime.now()
                }
            }
        }
    }

    fun recordChangesInTransaction(
        tenantId: UUID,
        entityType: String,
        entityId: UUID,
        changedBy: UUID,
        changes: Map<String, Pair<String?, String?>>
    ) = transaction { recordChanges(tenantId, entityType, entityId, changedBy, changes) }
}
