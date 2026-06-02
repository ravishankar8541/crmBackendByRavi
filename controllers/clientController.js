const Client = require('../models/Client')

exports.addClient = async (req, res) => {
    try {
        const { 
            name, 
            email, 
            phone, 
            companyName, 
            gstNumber, 
            category, 
            address,
            leadOwner,      // ✅ ADDED
            clientStatus, 
            remarks
        } = req.body;

        // 1. Basic Validation
        if (!name || !email || !phone || !companyName) {
            return res.status(400).json({
                success: false,
                message: 'Please provide all required fields',
            });
        }

        // 2. Check if client already exists (by email or phone)
        const existingClient = await Client.findOne({ 
            $or: [{ email: email.toLowerCase() }, { phone }] 
        });

        if (existingClient) {
            return res.status(400).json({
                success: false,
                message: 'Client with this email or phone already exists',
            });
        }

        // 3. Create New Client object
        const newClient = new Client({
            name,
            email: email.toLowerCase(),
            phone,
            companyName,
            gstNumber,
            category,
            address,
            leadOwner: leadOwner || '',     // ✅ ADDED
            clientStatus: clientStatus || "New Client",
            remarks
        });

        // 4. Save to Database
        await newClient.save();

        // 5. Success Response
        return res.status(201).json({
            success: true,
            message: 'Client added successfully',
            data: newClient,
        });

    } catch (error) {
        console.error('adding client error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error during adding Client',
            error: error.message,
        });
    }
}

exports.clients = async (req, res) => {
    try {
        // Fetch all clients, sorted by newest first
        const clients = await Client.find().sort({ createdAt: -1 });

        // Changed status from 400 to 200 (Success)
        return res.status(200).json({
            success: true,
            count: clients.length,
            clients
        });

    } catch (error) {
        console.error('fetching error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error during fetching Client',
            error: error.message,
        });
    }
}

exports.editClient = async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = { ...req.body };

        const client = await Client.findById(id);
        if (!client) {
            return res.status(404).json({ success: false, message: 'Client not found' });
        }

        // Update leadOwner if provided
        if (updateData.leadOwner !== undefined) {
            client.leadOwner = updateData.leadOwner;
        }

        // Latest fields update
        if (updateData.convertedService) client.convertedService = updateData.convertedService;
        if (updateData.convertedDealAmout !== undefined) client.convertedDealAmout = updateData.convertedDealAmout;
        if (updateData.convertedStartDate) client.convertedStartDate = updateData.convertedStartDate;
        if (updateData.convertedDuration) client.convertedDuration = updateData.convertedDuration;
        if (updateData.convertedLeadOwner) client.convertedLeadOwner = updateData.convertedLeadOwner;
        if (updateData.convertedRemarks) client.convertedRemarks = updateData.convertedRemarks;

        // Followup - Multiple allowed
        if (updateData.status === "Followup" && updateData.nextFollowUpDate) {
            client.followUpHistory.push({
                nextFollowUpDate: updateData.nextFollowUpDate,
                comment: updateData.followUpComment || "",
                updatedAt: new Date()
            });
            client.latestFollowUpDate = updateData.nextFollowUpDate;
        }

        // Prospect
        if (updateData.status === "Prospect" && updateData.prospectDate) {
            client.prospectHistory.push({
                prospectDate: updateData.prospectDate,
                comment: updateData.prospectComment || "",
                updatedAt: new Date()
            });
            client.latestProspectDate = updateData.prospectDate;
        }

        // Converted - Multiple allowed
        if (updateData.status === "Converted") {
            client.convertedHistory.push({
                service: updateData.convertedService,
                convertedDealAmout: updateData.convertedDealAmout,
                startDate: updateData.convertedStartDate,
                duration: updateData.convertedDuration,
                leadOwner: updateData.convertedLeadOwner,
                remarks: updateData.convertedRemarks,
                convertedAt: new Date()
            });
        }

        Object.assign(client, updateData);

        const updatedClient = await client.save();

        return res.status(200).json({
            success: true,
            message: 'Client updated successfully',
            data: updatedClient
        });

    } catch (error) {
        console.error('Editing client error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
}

exports.deleteClient = async (req, res) => {
    const { id } = req.params; 
    try {
        const client = await Client.findByIdAndDelete(id);

        if (!client) {
            return res.status(404).json({
                success: false,
                message: "Client not found"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Client deleted successfully"
        });

    } catch (error) {
        console.error("Delete client error", error);
        return res.status(500).json({
            success: false,
            message: "Server error during delete client",
            error: error.message
        });
    }
};