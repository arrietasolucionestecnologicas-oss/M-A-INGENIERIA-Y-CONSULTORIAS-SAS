package com.michael.tms.service

import com.michael.tms.db.Tenants
import com.michael.tms.db.TestSessions
import com.michael.tms.db.Transformers
import com.michael.tms.db.Users
import com.michael.tms.db.toEntityId
import com.michael.tms.model.CreateTestSessionRequest
import com.michael.tms.model.SessionStatus
import com.michael.tms.model.TestSessionResponse
import com.michael.tms.model.UpdateTestSessionRequest
import com.michael.tms.security.NotFoundException
import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.eq
import org.jetbrains.exposed.sql.insertAndGetId
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import org.jetbrains.exposed.sql.update
import java.time.LocalDate
import java.time.LocalDateTime
import java.util.UUID

object TestSessionService {

    fun create(tenantId: UUID, transformerId: UUID, request: CreateTestSessionRequest, responsibleUserId: UUID): TestSessionResponse = transaction {
        TransformerService.fetchRow(tenantId, transformerId)

        val id = TestSessions.insertAndGetId {
            it[TestSessions.tenantId] = tenantId.toEntityId(Tenants)
            it[TestSessions.transformerId] = transformerId.toEntityId(Transformers)
            it[testDate] = LocalDate.parse(request.testDate)
            it[TestSessions.responsibleUserId] = responsibleUserId.toEntityId(Users)
            it[ambientTemperatureC] = request.ambientTemperatureC
            it[relativeHumidityPct] = request.relativeHumidityPct
            it[sessionStatus] = SessionStatus.BORRADOR.name
            it[generalNotes] = request.generalNotes
        }
        toResponse(fetchRow(tenantId, id.value))
    }

    fun listByTransformer(tenantId: UUID, transformerId: UUID): List<TestSessionResponse> = transaction {
        TestSessions.selectAll()
            .where { (TestSessions.tenantId eq tenantId) and (TestSessions.transformerId eq transformerId) }
            .map { toResponse(it) }
    }

    fun list(tenantId: UUID, transformerId: UUID?, status: SessionStatus?): List<TestSessionResponse> = transaction {
        var condition = (TestSessions.tenantId eq tenantId)
        if (transformerId != null) condition = condition and (TestSessions.transformerId eq transformerId)
        if (status != null) condition = condition and (TestSessions.sessionStatus eq status.name)
        TestSessions.selectAll().where { condition }.map { toResponse(it) }
    }

    fun get(tenantId: UUID, id: UUID): TestSessionResponse = transaction {
        toResponse(fetchRow(tenantId, id))
    }

    fun update(tenantId: UUID, id: UUID, request: UpdateTestSessionRequest): TestSessionResponse = transaction {
        fetchRow(tenantId, id)
        TestSessions.update({ (TestSessions.tenantId eq tenantId) and (TestSessions.id eq id) }) { stmt ->
            request.testDate?.let { stmt[testDate] = LocalDate.parse(it) }
            request.ambientTemperatureC?.let { stmt[ambientTemperatureC] = it }
            request.relativeHumidityPct?.let { stmt[relativeHumidityPct] = it }
            request.sessionStatus?.let { stmt[sessionStatus] = it.name }
            request.generalNotes?.let { stmt[generalNotes] = it }
            stmt[updatedAt] = LocalDateTime.now()
        }
        toResponse(fetchRow(tenantId, id))
    }

    fun fetchRow(tenantId: UUID, id: UUID): ResultRow =
        TestSessions.selectAll().where { (TestSessions.tenantId eq tenantId) and (TestSessions.id eq id) }.singleOrNull()
            ?: throw NotFoundException("Sesión de ensayo no encontrada: $id")

    private fun toResponse(row: ResultRow) = TestSessionResponse(
        id = row[TestSessions.id].value.toString(),
        transformerId = row[TestSessions.transformerId].value.toString(),
        testDate = row[TestSessions.testDate].iso(),
        responsibleUserId = row[TestSessions.responsibleUserId].value.toString(),
        ambientTemperatureC = row[TestSessions.ambientTemperatureC],
        relativeHumidityPct = row[TestSessions.relativeHumidityPct],
        sessionStatus = row[TestSessions.sessionStatus],
        generalNotes = row[TestSessions.generalNotes],
        createdAt = row[TestSessions.createdAt].iso(),
        updatedAt = row[TestSessions.updatedAt].iso()
    )
}
