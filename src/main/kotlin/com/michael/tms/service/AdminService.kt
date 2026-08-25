package com.michael.tms.service

import com.michael.tms.db.AdminTokens
import com.michael.tms.db.Tenants
import com.michael.tms.model.CreateTenantRequest
import com.michael.tms.model.TenantResponse
import com.michael.tms.model.UpdateTenantRequest
import com.michael.tms.security.NotFoundException
import com.michael.tms.security.PasswordHashing
import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.eq
import org.jetbrains.exposed.sql.insertAndGetId
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import org.jetbrains.exposed.sql.update
import java.time.LocalDateTime
import java.util.UUID

object AdminService {

    fun isValidMasterToken(rawToken: String): Boolean = transaction {
        AdminTokens.selectAll()
            .where { AdminTokens.isActive eq true }
            .any { PasswordHashing.matches(rawToken, it[AdminTokens.tokenHash]) }
    }

    fun createTenant(request: CreateTenantRequest): TenantResponse = transaction {
        val id = Tenants.insertAndGetId {
            it[companyName] = request.companyName
            it[taxId] = request.taxId
            it[plan] = request.plan.name
            it[maxUsers] = request.maxUsers
            it[isActive] = true
        }
        toResponse(fetchRow(id.value))
    }

    fun listTenants(): List<TenantResponse> = transaction {
        Tenants.selectAll().map { toResponse(it) }
    }

    fun getTenant(id: UUID): TenantResponse = transaction {
        toResponse(fetchRow(id))
    }

    fun updateTenant(id: UUID, request: UpdateTenantRequest): TenantResponse = transaction {
        fetchRow(id) // valida existencia

        Tenants.update({ Tenants.id eq id }) { stmt ->
            request.companyName?.let { stmt[companyName] = it }
            request.taxId?.let { stmt[taxId] = it }
            request.isActive?.let { stmt[isActive] = it }
            request.plan?.let { stmt[plan] = it.name }
            request.maxUsers?.let { stmt[maxUsers] = it }
            request.subscriptionExpiresAt?.let { stmt[subscriptionExpiresAt] = LocalDateTime.parse(it) }
            stmt[updatedAt] = LocalDateTime.now()
        }

        toResponse(fetchRow(id))
    }

    /** Baja lógica: equivalente a suspender la cuenta (is_active = false), nunca se borra el historial. */
    fun deactivateTenant(id: UUID): TenantResponse = transaction {
        fetchRow(id)
        Tenants.update({ Tenants.id eq id }) {
            it[isActive] = false
            it[updatedAt] = LocalDateTime.now()
        }
        toResponse(fetchRow(id))
    }

    private fun fetchRow(id: UUID): ResultRow =
        Tenants.selectAll().where { Tenants.id eq id }.singleOrNull()
            ?: throw NotFoundException("Tenant no encontrado: $id")

    private fun toResponse(row: ResultRow) = TenantResponse(
        id = row[Tenants.id].value.toString(),
        companyName = row[Tenants.companyName],
        taxId = row[Tenants.taxId],
        isActive = row[Tenants.isActive],
        plan = row[Tenants.plan],
        maxUsers = row[Tenants.maxUsers],
        subscriptionExpiresAt = row[Tenants.subscriptionExpiresAt]?.iso(),
        createdAt = row[Tenants.createdAt].iso(),
        updatedAt = row[Tenants.updatedAt].iso()
    )
}
