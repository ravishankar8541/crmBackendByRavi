const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
    amount: {
        type: Number,
        required: true,
        min: 0
    },
    paymentDate: {
        type: Date,
        default: Date.now
    },
    paymentMethod: {
        type: String,
        enum: ['Cash', 'Bank Transfer', 'Cheque', 'UPI', 'Credit Card', 'Debit Card'],
        required: true
    },
    transactionId: {
        type: String,
        trim: true
    },
    remarks: {
        type: String,
        default: ''
    },
    receivedBy: {
        type: String,
        required: true
    }
}, { timestamps: true });

// Service Item Schema for multiple services
const serviceItemSchema = new mongoose.Schema({
    serviceName: {
        type: String,
        required: true
    },
    description: {
        type: String,
        default: ''
    },
    quantity: {
        type: Number,
        default: 1,
        min: 1
    },
    unitPrice: {
        type: Number,
        required: true,
        min: 0
    },
    totalPrice: {
        type: Number,
        required: true,
        min: 0
    },
    gstRate: {
        type: Number,
        default: 0,
        min: 0,
        max: 100
    },
    gstAmount: {
        type: Number,
        default: 0
    },
    cgst: {
        type: Number,
        default: 0
    },
    sgst: {
        type: Number,
        default: 0
    },
    igst: {
        type: Number,
        default: 0
    }
});

const billSchema = new mongoose.Schema({
    billNumber: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    clientId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Client',
        required: true
    },
    serviceName: {
        type: String,
        default: ''
    },
    description: {
        type: String,
        default: ''
    },
    services: [serviceItemSchema],
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
    subtotal: {
        type: Number,
        default: 0
    },
    totalGstAmount: {
        type: Number,
        default: 0
    },
    gstAmount: {
        type: Number,
        default: 0,
        min: 0
    },
    cgst: {
        type: Number,
        default: 0
    },
    sgst: {
        type: Number,
        default: 0
    },
    igst: {
        type: Number,
        default: 0
    },
    discount: {
        type: Number,
        default: 0,
        min: 0
    },
    discountType: {
        type: String,
        enum: ['percentage', 'fixed'],
        default: 'percentage'
    },
    taxType: {
        type: String,
        enum: ['CGST+SGST', 'IGST'],
        default: 'CGST+SGST'
    },
    billDate: {
        type: Date,
        default: Date.now
    },
    dueDate: {
        type: Date,
        required: true
    },
    status: {
        type: String,
        enum: ['Draft', 'Pending', 'Partially Paid', 'Paid', 'Overdue', 'Cancelled'],
        default: 'Pending'
    },
    payments: [paymentSchema],
    notes: {
        type: String,
        default: ''
    },
    createdBy: {
        type: String,
        required: true
    },
    isRecurring: {
        type: Boolean,
        default: false
    },
    recurringPeriod: {
        type: String,
        enum: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
        default: null
    }
}, { timestamps: true });

// Method to calculate due amount and status
billSchema.methods.calculateBill = function() {
    this.dueAmount = this.totalAmount - this.paidAmount;

    const now = new Date();
    const dueDate = new Date(this.dueDate);

    if (this.dueAmount <= 0) {
        this.status = 'Paid';
    } else if (this.paidAmount > 0 && this.dueAmount > 0) {
        this.status = 'Partially Paid';
    } else if (now > dueDate && this.dueAmount > 0) {
        this.status = 'Overdue';
    } else {
        this.status = 'Pending';
    }

    return this;
};

// Method to calculate totals for multiple services
billSchema.methods.calculateTotals = function() {
    let subtotal = 0;
    let totalGst = 0;
    let cgstTotal = 0;
    let sgstTotal = 0;
    let igstTotal = 0;
    
    if (this.services && this.services.length > 0) {
        this.services.forEach(service => {
            subtotal += service.totalPrice;
            totalGst += service.gstAmount || 0;
            cgstTotal += service.cgst || 0;
            sgstTotal += service.sgst || 0;
            igstTotal += service.igst || 0;
        });
    } else {
        subtotal = this.totalAmount - (this.gstAmount || 0);
        totalGst = this.gstAmount || 0;
    }
    
    let discountAmount = 0;
    if (this.discount > 0) {
        if (this.discountType === 'percentage') {
            discountAmount = (subtotal * this.discount) / 100;
        } else {
            discountAmount = this.discount;
        }
    }
    
    this.subtotal = subtotal;
    this.totalGstAmount = totalGst;
    this.totalAmount = subtotal + totalGst - discountAmount;
    this.cgst = cgstTotal;
    this.sgst = sgstTotal;
    this.igst = igstTotal;
    
    this.calculateBill();
    
    return this;
};

// Method to add payment
billSchema.methods.addPayment = async function(paymentData) {
    this.payments.push(paymentData);
    this.paidAmount += paymentData.amount;
    this.calculateBill();
    await this.save();
    return this;
};

// NO pre-save middleware - We'll call calculate manually in controller

module.exports = mongoose.model("Bill", billSchema);