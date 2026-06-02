// models/ServiceBill.js
const mongoose = require('mongoose');

const serviceBillSchema = new mongoose.Schema({
    clientId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Client',
        required: true
    },
    serviceName: {
        type: String,
        required: true
    },
    description: {
        type: String,
        default: ''
    },
    totalAmount: {
        type: Number,
        required: true,
        min: 0
    },
    paidAmount: {
        type: Number,
        default: 0,
        min: 0
    },
    dueAmount: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        enum: ['Pending', 'Partially Paid', 'Paid'],
        default: 'Pending'
    },
    payments: [{
        amount: Number,
        paymentDate: { type: Date, default: Date.now },
        paymentMethod: String,
        transactionId: String,
        remarks: String,
        receivedBy: String,
        billNumber: String  
    }],
    bills: [{
        billId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill' },
        billNumber: String,
        amount: Number,
        paymentReceived: Number,
        date: Date
    }]
}, { timestamps: true });

module.exports = mongoose.model('ServiceBill', serviceBillSchema);