const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        trim: true,
        lowercase: true
    },
    phone: {
        type: String,
        required: true,
        trim: true
    },
    companyName: {
        type: String,
        required: true,
        trim: true
    },
    gstNumber: {
        type: String,
        trim: true
    },
    category: {
        type: String,
        required: true
    },
    address: {
        type: String,
        required: false
    },
     leadOwner: { type: String, default: '' },
    clientStatus: {
        type: String,
        required: true,
        default: "New Client"
    },

    status: {
        type: String,
        required: true,
        default: "New Client",
        enum: ["New Client", "Followup", "Prospect", "Converted"]
    },
    remarks: {
        type: String,
        default: ""
    },
    followUpHistory: [{
        nextFollowUpDate: Date,
        comment: String,
        updatedAt: { type: Date, default: Date.now }
    }],

    prospectHistory: [{
        prospectDate: Date,
        comment: String,
        updatedAt: { type: Date, default: Date.now }
    }],

    convertedHistory: [{
        service: String,
        convertedDealAmout: String,
        startDate: Date,
        duration: String,
        leadOwner: String,
        remarks: String,
        convertedAt: { type: Date, default: Date.now }
    }],
    convertedService: String,
    convertedDealAmout: String,
    convertedStartDate: Date,
    convertedDuration: String,
    convertedLeadOwner: String,
    convertedRemarks: String,
    latestFollowUpDate: { type: Date },
    latestProspectDate: { type: Date },

    addedDate: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

module.exports = mongoose.model("Client", clientSchema);