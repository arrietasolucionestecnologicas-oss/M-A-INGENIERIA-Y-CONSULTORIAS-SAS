package com.michael.tms.service

import com.michael.tms.db.Tenants
import org.jetbrains.exposed.sql.eq
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import java.util.UUID

/**
 * Resolución de tenant por slug para el login: el cliente nunca conoce ni envía el UUID
 * real del tenant, solo un código corto público (ej. "cliente01"). Separado de AdminService
 * porque este lookup es de uso público (sin token maestro), a diferencia de la administración
 * de tenants que sí requiere X-Master-Token.
 */
object TenantLookupService {

    data class TenantLookupResult(val id: UUID, val isActive: Boolean)

    fun findBySlug(slug: String): TenantLookupResult? = transaction {
        Tenants.selectAll()
            .where { Tenants.slug eq slug }
            .singleOrNull()
            ?.let { TenantLookupResult(id = it[Tenants.id].value, isActive = it[Tenants.isActive]) }
    }
}
