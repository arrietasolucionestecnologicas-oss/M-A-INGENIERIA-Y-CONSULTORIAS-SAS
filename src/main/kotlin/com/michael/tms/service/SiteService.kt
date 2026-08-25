package com.michael.tms.service

import com.michael.tms.db.ClientSites
import com.michael.tms.db.Tenants
import com.michael.tms.db.toEntityId
import com.michael.tms.model.CreateSiteRequest
import com.michael.tms.model.SiteResponse
import com.michael.tms.model.UpdateSiteRequest
import com.michael.tms.security.NotFoundException
import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.deleteWhere
import org.jetbrains.exposed.sql.eq
import org.jetbrains.exposed.sql.insertAndGetId
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import org.jetbrains.exposed.sql.update
import java.time.LocalDateTime
import java.util.UUID

object SiteService {

    fun create(tenantId: UUID, request: CreateSiteRequest): SiteResponse = transaction {
        val id = ClientSites.insertAndGetId {
            it[ClientSites.tenantId] = tenantId.toEntityId(Tenants)
            it[clientName] = request.clientName
            it[siteName] = request.siteName
            it[address] = request.address
            it[latitude] = request.latitude
            it[longitude] = request.longitude
        }
        toResponse(fetchRow(tenantId, id.value))
    }

    fun list(tenantId: UUID): List<SiteResponse> = transaction {
        ClientSites.selectAll().where { ClientSites.tenantId eq tenantId }.map { toResponse(it) }
    }

    fun get(tenantId: UUID, id: UUID): SiteResponse = transaction {
        toResponse(fetchRow(tenantId, id))
    }

    fun update(tenantId: UUID, id: UUID, request: UpdateSiteRequest): SiteResponse = transaction {
        fetchRow(tenantId, id)
        ClientSites.update({ (ClientSites.tenantId eq tenantId) and (ClientSites.id eq id) }) { stmt ->
            request.clientName?.let { stmt[clientName] = it }
            request.siteName?.let { stmt[siteName] = it }
            request.address?.let { stmt[address] = it }
            request.latitude?.let { stmt[latitude] = it }
            request.longitude?.let { stmt[longitude] = it }
            stmt[updatedAt] = LocalDateTime.now()
        }
        toResponse(fetchRow(tenantId, id))
    }

    fun delete(tenantId: UUID, id: UUID) = transaction {
        fetchRow(tenantId, id)
        ClientSites.deleteWhere { (ClientSites.tenantId eq tenantId) and (ClientSites.id eq id) }
        Unit
    }

    fun fetchRow(tenantId: UUID, id: UUID): ResultRow =
        ClientSites.selectAll().where { (ClientSites.tenantId eq tenantId) and (ClientSites.id eq id) }.singleOrNull()
            ?: throw NotFoundException("Sitio no encontrado: $id")

    private fun toResponse(row: ResultRow) = SiteResponse(
        id = row[ClientSites.id].value.toString(),
        clientName = row[ClientSites.clientName],
        siteName = row[ClientSites.siteName],
        address = row[ClientSites.address],
        latitude = row[ClientSites.latitude],
        longitude = row[ClientSites.longitude],
        createdAt = row[ClientSites.createdAt].iso()
    )
}
