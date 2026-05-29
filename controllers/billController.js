const Bill = require('../models/Bill');
const Client = require('../models/Client');
const ServiceBill = require('../models/ServiceBill');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const generateBillNumber = async (retryCount = 0) => {
    const year = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, '0');
    const date = String(new Date().getDate()).padStart(2, '0');

    // Get last bill number for this month
    const lastBill = await Bill.findOne({
        billNumber: { $regex: `INV/${year}/${month}` }
    }).sort({ createdAt: -1 });

    let sequence = 1;
    if (lastBill) {
        const lastSequence = parseInt(lastBill.billNumber.split('/').pop());
        sequence = lastSequence + 1;
    }

    const billNumber = `INV/${year}/${month}/${String(sequence).padStart(4, '0')}`;

    // Check if bill number already exists (double check)
    const exists = await Bill.findOne({ billNumber });
    if (exists && retryCount < 5) {
        return generateBillNumber(retryCount + 1);
    }

    return billNumber;
};

// Helper function to calculate GST
const calculateGST = (amount, gstRate, taxType = 'CGST+SGST') => {
    const gstAmount = (amount * gstRate) / 100;

    if (taxType === 'IGST') {
        return {
            gstAmount: gstAmount,
            cgst: 0,
            sgst: 0,
            igst: gstAmount
        };
    } else {
        return {
            gstAmount: gstAmount,
            cgst: gstAmount / 2,
            sgst: gstAmount / 2,
            igst: 0
        };
    }
};
exports.createBill = async (req, res) => {
    try {
        const {
            clientId,
            serviceName,
            description,
            totalAmount,
            dueDate,
            gstAmount,
            notes,
            initialPayment,
            paymentMethod,
            transactionId,
            paymentRemarks,
            services
        } = req.body;

        // Validate required fields
        if (!clientId) {
            return res.status(400).json({
                success: false,
                message: 'Client ID is required'
            });
        }

        const client = await Client.findById(clientId);
        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        const billNumber = await generateBillNumber();

        let parsedTotalAmount = 0;
        let parsedSubtotal = 0;
        let parsedTotalGst = 0;

        // Check if this is a multiple services bill
        if (services && Array.isArray(services) && services.length > 0) {
            for (const service of services) {
                const quantity = service.quantity || 1;
                const unitPrice = parseFloat(service.unitPrice) || 0;
                const totalPrice = quantity * unitPrice;
                const gstRate = parseFloat(service.gstRate) || 0;
                const gstAmountCalc = (totalPrice * gstRate) / 100;

                parsedSubtotal += totalPrice;
                parsedTotalGst += gstAmountCalc;
            }

            let discountAmount = 0;
            if (req.body.discount) {
                const discount = parseFloat(req.body.discount) || 0;
                const discountType = req.body.discountType || 'percentage';
                if (discountType === 'percentage') {
                    discountAmount = (parsedSubtotal * discount) / 100;
                } else {
                    discountAmount = discount;
                }
            }
            parsedTotalAmount = parsedSubtotal + parsedTotalGst - discountAmount;
        } else {
            parsedTotalAmount = parseFloat(totalAmount) || 0;
        }

        const parsedInitialPayment = parseFloat(initialPayment) || 0;

        if (parsedInitialPayment > parsedTotalAmount) {
            return res.status(400).json({
                success: false,
                message: 'Initial payment cannot exceed total amount'
            });
        }

        // 🔴 FIX: Get display service name for bills table
        let displayServiceName = serviceName || '';
        if ((!displayServiceName || displayServiceName === '') && services && services.length > 0) {
            const serviceNames = services.map(s => s.serviceName).filter(n => n && n !== '');
            displayServiceName = serviceNames.join(', ');
            if (displayServiceName.length > 50) {
                displayServiceName = displayServiceName.substring(0, 47) + '...';
            }
        }
        if (!displayServiceName || displayServiceName === '') {
            displayServiceName = 'Multi-Service Bill';
        }

        const newBill = new Bill({
            billNumber,
            clientId,
            serviceName: displayServiceName,  // ← FIXED
            description: description || '',
            totalAmount: parsedTotalAmount,
            dueDate: new Date(dueDate),
            gstAmount: parseFloat(gstAmount) || parsedTotalGst,
            notes: notes || '',
            createdBy: req.user?.username || 'System',
            paidAmount: parsedInitialPayment,
            subtotal: parsedSubtotal,
            totalGstAmount: parsedTotalGst,
            discount: parseFloat(req.body.discount) || 0,
            discountType: req.body.discountType || 'percentage'
        });

        newBill.dueAmount = parsedTotalAmount - parsedInitialPayment;
        newBill.calculateBill();
        if (parsedInitialPayment > 0) {
            newBill.payments.push({
                amount: parsedInitialPayment,
                paymentMethod: paymentMethod || 'Cash',
                transactionId: transactionId || '',
                remarks: paymentRemarks || 'Initial payment at bill creation',
                receivedBy: req.user?.username || 'System',
                paymentDate: new Date()
            });
        }

        if (services && Array.isArray(services) && services.length > 0) {
            const processedServices = [];
            for (const service of services) {
                const quantity = service.quantity || 1;
                const unitPrice = parseFloat(service.unitPrice) || 0;
                const totalPrice = quantity * unitPrice;
                const gstRate = parseFloat(service.gstRate) || 0;
                const gstAmountCalc = (totalPrice * gstRate) / 100;

                processedServices.push({
                    serviceName: service.serviceName,
                    description: service.description || '',
                    quantity: quantity,
                    unitPrice: unitPrice,
                    totalPrice: totalPrice,
                    gstRate: gstRate,
                    gstAmount: gstAmountCalc,
                    cgst: gstAmountCalc / 2,
                    sgst: gstAmountCalc / 2,
                    igst: 0
                });
            }
            newBill.services = processedServices;
        }

        await newBill.save();
        console.log("✅ Bill saved successfully:", billNumber);

        await newBill.populate('clientId', 'name companyName email phone address gstNumber');

        // ServiceBill creation logic
        let serviceBillCreated = false;

        try {
            console.log("🟢 Starting ServiceBill creation/update...");

            // For single service
            if (serviceName && !services) {
                let serviceBill = await ServiceBill.findOne({
                    clientId: clientId,
                    serviceName: serviceName
                });

                if (!serviceBill) {
                    serviceBill = new ServiceBill({
                        clientId: clientId,
                        serviceName: serviceName,
                        totalAmount: parsedTotalAmount,
                        paidAmount: parsedInitialPayment,
                        dueAmount: parsedTotalAmount - parsedInitialPayment,
                        status: parsedInitialPayment >= parsedTotalAmount ? 'Paid' : (parsedInitialPayment > 0 ? 'Partially Paid' : 'Pending'),
                        bills: [{ billId: newBill._id, billNumber: billNumber, amount: parsedTotalAmount, paymentReceived: parsedInitialPayment, date: new Date() }]
                    });
                } else {
                    serviceBill.paidAmount += parsedInitialPayment;
                    serviceBill.dueAmount = serviceBill.totalAmount - serviceBill.paidAmount;
                    serviceBill.status = serviceBill.paidAmount >= serviceBill.totalAmount ? 'Paid' : (serviceBill.paidAmount > 0 ? 'Partially Paid' : 'Pending');

                    serviceBill.bills.push({
                        billId: newBill._id,
                        billNumber: billNumber,
                        amount: parsedTotalAmount,
                        paymentReceived: parsedInitialPayment,
                        date: new Date()
                    });
                }

                if (parsedInitialPayment > 0) {
                    serviceBill.payments.push({
                        amount: parsedInitialPayment,
                        paymentMethod: paymentMethod || 'Cash',
                        transactionId: transactionId || '',
                        remarks: paymentRemarks || 'Payment',
                        receivedBy: req.user?.username || 'System',
                        billNumber: billNumber
                    });
                }

                await serviceBill.save();
            }

            // For multiple services
            if (services && services.length > 0) {
                console.log("📌 Processing MULTIPLE services, count:", services.length);

                for (const service of services) {
                    console.log(`   Processing service: ${service.serviceName}`);

                    let serviceBill = await ServiceBill.findOne({
                        clientId: clientId,
                        serviceName: service.serviceName
                    });

                    const quantity = service.quantity || 1;
                    const unitPrice = parseFloat(service.unitPrice) || 0;
                    const totalPrice = quantity * unitPrice;
                    const gstRate = parseFloat(service.gstRate) || 0;
                    const gstAmountCalc = (totalPrice * gstRate) / 100;
                    const serviceTotal = totalPrice + gstAmountCalc;

                    const proportionalPayment = parsedInitialPayment > 0 && parsedTotalAmount > 0 ?
                        (parsedInitialPayment * serviceTotal) / parsedTotalAmount : 0;

                    if (!serviceBill) {
                        console.log(`   🆕 Creating NEW ServiceBill for: ${service.serviceName}`);
                        serviceBill = new ServiceBill({
                            clientId: clientId,
                            serviceName: service.serviceName,
                            totalAmount: serviceTotal,
                            paidAmount: proportionalPayment,
                            dueAmount: serviceTotal - proportionalPayment,
                            status: proportionalPayment >= serviceTotal ? 'Paid' :
                                proportionalPayment > 0 ? 'Partially Paid' : 'Pending',
                            bills: [{
                                billId: newBill._id,
                                billNumber: billNumber,
                                amount: serviceTotal,
                                paymentReceived: proportionalPayment,
                                date: new Date()
                            }]
                        });
                    } else {
                        console.log(`   📝 UPDATING existing ServiceBill for: ${service.serviceName}`);
                        console.log(`      Old total: ${serviceBill.totalAmount}, Old paid: ${serviceBill.paidAmount}`);

                        serviceBill.totalAmount += serviceTotal;
                        serviceBill.paidAmount += proportionalPayment;
                        serviceBill.dueAmount = serviceBill.totalAmount - serviceBill.paidAmount;
                        serviceBill.status = serviceBill.paidAmount >= serviceBill.totalAmount ? 'Paid' :
                            serviceBill.paidAmount > 0 ? 'Partially Paid' : 'Pending';

                        serviceBill.bills.push({
                            billId: newBill._id,
                            billNumber: billNumber,
                            amount: serviceTotal,
                            paymentReceived: proportionalPayment,
                            date: new Date()
                        });
                    }

                    if (proportionalPayment > 0) {
                        serviceBill.payments.push({
                            amount: proportionalPayment,
                            paymentMethod: paymentMethod || 'Cash',
                            transactionId: transactionId || '',
                            remarks: paymentRemarks || 'Initial payment',
                            receivedBy: req.user?.username || 'System',
                            billNumber: billNumber
                        });
                    }

                    await serviceBill.save();
                    console.log(`   ✅ ServiceBill saved for: ${service.serviceName}`);
                }
                serviceBillCreated = true;
            }

            if (!serviceBillCreated) {
                console.log("⚠️ No service bill was created - no service name provided");
            }

        } catch (serviceBillError) {
            console.error('❌ Error updating service bill:', serviceBillError);
            console.error('Error details:', serviceBillError.message);
        }

        console.log("========================================");
        console.log("🎉 Bill creation completed!");
        console.log("   Bill Number:", billNumber);
        console.log("========================================");

        return res.status(201).json({
            success: true,
            message: parsedInitialPayment > 0 ? 'Bill created with initial payment' : 'Bill created successfully',
            data: newBill
        });

    } catch (error) {
        console.error('❌ Create bill error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while creating bill',
            error: error.message
        });
    }
};

// Get all bills with filters
exports.getBills = async (req, res) => {
    try {
        const {
            status,
            clientId,
            startDate,
            endDate,
            page = 1,
            limit = 50
        } = req.query;

        let query = {};

        if (status && status !== 'All') query.status = status;
        if (clientId) query.clientId = clientId;

        if (startDate || endDate) {
            query.billDate = {};
            if (startDate) query.billDate.$gte = new Date(startDate);
            if (endDate) query.billDate.$lte = new Date(endDate);
        }

        const bills = await Bill.find(query)
            .populate('clientId', 'name companyName email phone')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit);

        const total = await Bill.countDocuments(query);

        return res.status(200).json({
            success: true,
            data: bills,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Get bills error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while fetching bills',
            error: error.message
        });
    }
};

// Get single bill by ID
exports.getBillById = async (req, res) => {
    try {
        const bill = await Bill.findById(req.params.id)
            .populate('clientId', 'name companyName email phone address gstNumber');

        if (!bill) {
            return res.status(404).json({
                success: false,
                message: 'Bill not found'
            });
        }

        return res.status(200).json({
            success: true,
            data: bill
        });

    } catch (error) {
        console.error('Get bill error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while fetching bill',
            error: error.message
        });
    }
};

exports.addPayment = async (req, res) => {
    try {
        const { id } = req.params;
        const { amount, paymentMethod, transactionId, remarks } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Valid payment amount is required'
            });
        }

        const bill = await Bill.findById(id);

        if (!bill) {
            return res.status(404).json({
                success: false,
                message: 'Bill not found'
            });
        }

        if (bill.status === 'Paid') {
            return res.status(400).json({
                success: false,
                message: 'Bill is already fully paid'
            });
        }

        const paymentAmount = parseFloat(amount);

        if (paymentAmount > bill.dueAmount) {
            return res.status(400).json({
                success: false,
                message: `Payment amount cannot exceed due amount of ₹${bill.dueAmount.toLocaleString('en-IN')}`
            });
        }

        const payment = {
            amount: paymentAmount,
            paymentMethod: paymentMethod || 'Cash',
            transactionId: transactionId || '',
            remarks: remarks || '',
            receivedBy: req.user?.username || 'System',
            paymentDate: new Date()
        };

        bill.payments.push(payment);
        bill.paidAmount += paymentAmount;
        // ✅ CRITICAL: Update due amount
        bill.dueAmount = bill.totalAmount - bill.paidAmount;

        // Update status
        if (bill.dueAmount <= 0) {
            bill.status = 'Paid';
        } else if (bill.paidAmount > 0) {
            bill.status = 'Partially Paid';
        }

        await bill.save();
        await bill.populate('clientId', 'name companyName email phone');

        return res.status(200).json({
            success: true,
            message: 'Payment added successfully',
            data: bill
        });

    } catch (error) {
        console.error('Add payment error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while adding payment',
            error: error.message
        });
    }
};

// Update bill
exports.updateBill = async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const bill = await Bill.findById(id);

        if (!bill) {
            return res.status(404).json({
                success: false,
                message: 'Bill not found'
            });
        }

        if (bill.status === 'Paid') {
            return res.status(400).json({
                success: false,
                message: 'Cannot edit a paid bill'
            });
        }

        const allowedUpdates = ['serviceName', 'description', 'totalAmount', 'dueDate', 'gstAmount', 'notes'];

        allowedUpdates.forEach(field => {
            if (updates[field] !== undefined) {
                if (field === 'totalAmount') {
                    bill[field] = parseFloat(updates[field]);
                } else if (field === 'dueDate') {
                    bill[field] = new Date(updates[field]);
                } else if (field === 'gstAmount') {
                    bill[field] = parseFloat(updates[field]) || 0;
                } else {
                    bill[field] = updates[field];
                }
            }
        });

        if (bill.calculateBill) {
            bill.calculateBill();
        }

        await bill.save();
        await bill.populate('clientId', 'name companyName email phone');

        return res.status(200).json({
            success: true,
            message: 'Bill updated successfully',
            data: bill
        });

    } catch (error) {
        console.error('Update bill error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while updating bill',
            error: error.message
        });
    }
};

// Delete bill
exports.deleteBill = async (req, res) => {
    try {
        const { id } = req.params;

        const bill = await Bill.findById(id);

        if (!bill) {
            return res.status(404).json({
                success: false,
                message: 'Bill not found'
            });
        }

        if (bill.payments && bill.payments.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete bill with existing payments'
            });
        }

        if (bill.status === 'Paid') {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete a paid bill'
            });
        }

        await Bill.findByIdAndDelete(id);

        return res.status(200).json({
            success: true,
            message: 'Bill deleted successfully'
        });

    } catch (error) {
        console.error('Delete bill error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while deleting bill',
            error: error.message
        });
    }
};

// Get client billing summary
exports.getClientBillingSummary = async (req, res) => {
    try {
        const { clientId } = req.params;

        // Validate clientId
        if (!clientId || clientId === 'undefined' || clientId === 'null') {
            return res.status(400).json({
                success: false,
                message: 'Valid client ID is required'
            });
        }

        // Get ALL bills including installment bills
        const bills = await Bill.find({ clientId: clientId }).sort({ billDate: -1 });

        console.log(`📊 Found ${bills.length} bills for client ${clientId}`);

        const summary = {
            totalBilled: 0,
            totalPaid: 0,
            totalDue: 0,
            billsCount: bills.length,
            overdueBills: 0,
            bills: bills.map(bill => ({
                _id: bill._id,
                billNumber: bill.billNumber,
                totalAmount: bill.totalAmount,
                paidAmount: bill.paidAmount,
                dueAmount: bill.dueAmount,
                status: bill.status,
                dueDate: bill.dueDate,
                billDate: bill.billDate,
                serviceName: bill.serviceName || (bill.services && bill.services[0]?.serviceName) || 'Installment Bill'
            }))
        };

        bills.forEach(bill => {
            summary.totalBilled += bill.totalAmount;
            summary.totalPaid += bill.paidAmount;
            summary.totalDue += bill.dueAmount;
            if (bill.status === 'Overdue') summary.overdueBills++;
        });

        return res.status(200).json({
            success: true,
            data: summary
        });

    } catch (error) {
        console.error('Get client billing summary error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while fetching client billing summary',
            error: error.message
        });
    }
};

// Get payment history
exports.getPaymentHistory = async (req, res) => {
    try {
        const { id } = req.params;

        const bill = await Bill.findById(id);

        if (!bill) {
            return res.status(404).json({
                success: false,
                message: 'Bill not found'
            });
        }

        return res.status(200).json({
            success: true,
            data: bill.payments
        });

    } catch (error) {
        console.error('Get payment history error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while fetching payment history',
            error: error.message
        });
    }
};

exports.downloadBill = async (req, res) => {
    try {
        const bill = await Bill.findById(req.params.id)
            .populate('clientId', 'name companyName email phone address gstNumber');

        if (!bill) {
            return res.status(404).json({ success: false, message: 'Bill not found' });
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="invoice-${bill.billNumber}.pdf"`);

        const doc = new PDFDocument({
            margin: 50,
            size: 'A4',
            bufferPages: true
        });

        doc.pipe(res);

        // ==================== COLORS & STYLES ====================
        const colors = {
            primary: '#1E3A8A',      // Deep Blue (main brand color)
            secondary: '#3B82F6',    // Lighter blue accent
            accent: '#E31E24',       // Red accent for company name
            success: '#10B981',
            warning: '#F59E0B',
            danger: '#EF4444',
            textDark: '#111827',
            textMedium: '#4B5563',
            textLight: '#6B7280',
            border: '#E5E7EB',
            bgLight: '#F8FAFC',
            bgCard: '#F0F9FF'
        };

        // Helper function for currency formatting
        const formatCurrency = (amount) => {
            return `₹${(amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        };

        // ==================== LOGO (LEFT SIDE TOP) ====================
        const logoPath = path.join(__dirname, '../assets/blackLogo.png');
        try {
            if (fs.existsSync(logoPath)) {
                doc.image(logoPath, 50, 35, { width: 70 });
            } else {
                console.log('Logo not found at:', logoPath);
            }
        } catch (err) {
            console.log('Logo error:', err.message);
        }

        // ==================== HEADER SECTION ====================
        // Company Name with accent color
        doc.fontSize(24)
           .font('Helvetica-Bold')
           .fillColor(colors.accent)
           .text('VIRAL ADS MEDIA', 300, 40, { align: 'right' });

        doc.fontSize(9)
           .font('Helvetica')
           .fillColor(colors.textMedium)
           .text('DIGITAL CREATIVE AGENCY', 300, 68, { align: 'right' });

        // Invoice Title with premium styling
        doc.fontSize(28)
           .font('Helvetica-Bold')
           .fillColor(colors.primary)
           .text('INVOICE', 140, 45);

        // Invoice metadata box
        const metaBoxX = 400;
        const metaBoxY = 35;
        doc.roundedRect(metaBoxX - 10, metaBoxY, 155, 70, 5)
           .fill(colors.bgLight)
           .stroke(colors.border);

        doc.fontSize(9)
           .font('Helvetica-Bold')
           .fillColor(colors.textDark);
        
        const cleanBillNumber = bill.billNumber.replace(/\//g, '');
        doc.text('INVOICE NO', metaBoxX, metaBoxY + 8);
        doc.font('Helvetica').fillColor(colors.primary);
        doc.text(cleanBillNumber, metaBoxX, metaBoxY + 22);
        
        doc.font('Helvetica-Bold').fillColor(colors.textDark);
        doc.text('INVOICE DATE', metaBoxX, metaBoxY + 42);
        doc.font('Helvetica').fillColor(colors.textMedium);
        doc.text(new Date(bill.billDate).toLocaleDateString('en-US', { 
            month: 'short', day: 'numeric', year: 'numeric' 
        }), metaBoxX, metaBoxY + 56);
        
        if (bill.dueDate) {
            doc.font('Helvetica-Bold').fillColor(colors.textDark);
            doc.text('DUE DATE', metaBoxX, metaBoxY + 72);
            doc.font('Helvetica').fillColor(colors.danger);
            doc.text(new Date(bill.dueDate).toLocaleDateString('en-US', { 
                month: 'short', day: 'numeric', year: 'numeric' 
            }), metaBoxX, metaBoxY + 86);
        }

        // Decorative divider
        doc.moveTo(50, 115).lineTo(545, 115).lineWidth(0.8).stroke(colors.border);
        doc.moveTo(50, 116).lineTo(545, 116).lineWidth(0.3).stroke(colors.border);

        // ==================== BILLED BY & BILLED TO ====================
        const billedY = 135;

        // Billed By Card
        doc.roundedRect(50, billedY, 240, 130, 6)
           .fill(colors.bgLight)
           .stroke(colors.border);
        
        doc.fontSize(10)
           .font('Helvetica-Bold')
           .fillColor(colors.primary)
           .text('BILLED BY', 60, billedY + 12);
        
        doc.fontSize(9)
           .font('Helvetica')
           .fillColor(colors.textMedium);
        
        let byY = billedY + 32;
        doc.text('Viral Ads Media', 60, byY);
        doc.text('B-27, Khatu shyam Mandir Road, near Max Bazar,', 60, byY + 14);
        doc.text('Budh Vihar Phase I, New Delhi, Delhi,', 60, byY + 28);
        doc.text('India - 110086', 60, byY + 42);
        doc.text('GSTIN: 07DTXPK7339P1ZF', 60, byY + 58);
        doc.text('PAN: DTXPK7339P', 60, byY + 72);
        doc.text('Email: info@viraladsmedia.com', 60, byY + 86);
        doc.text('Phone: +91 93544 91934', 60, byY + 100);

        // Billed To Card
        doc.roundedRect(310, billedY, 240, 130, 6)
           .fill(colors.bgLight)
           .stroke(colors.border);
        
        doc.fontSize(10)
           .font('Helvetica-Bold')
           .fillColor(colors.primary)
           .text('BILLED TO', 320, billedY + 12);
        
        doc.fontSize(9)
           .font('Helvetica')
           .fillColor(colors.textMedium);

        const client = bill.clientId;
        let toY = billedY + 32;
        doc.text(client.companyName || client.name, 320, toY);
        
        if (client.address) {
            const address = client.address;
            let remaining = address;
            let lineY = toY + 14;
            while (remaining.length > 38) {
                let splitIndex = remaining.lastIndexOf(' ', 38);
                if (splitIndex === -1) splitIndex = 38;
                doc.text(remaining.substring(0, splitIndex), 320, lineY);
                remaining = remaining.substring(splitIndex + 1);
                lineY += 14;
            }
            if (remaining.length > 0) {
                doc.text(remaining, 320, lineY);
                lineY += 14;
            }
            toY = lineY - 14;
        }

        let infoY = toY + 28;
        if (client.gstNumber) {
            doc.text(`GSTIN: ${client.gstNumber}`, 320, infoY);
            infoY += 16;
        }
        if (client.email) {
            doc.text(`Email: ${client.email}`, 320, infoY);
            infoY += 16;
        }
        if (client.phone) {
            doc.text(`Phone: ${client.phone}`, 320, infoY);
        }

        // ==================== PAYMENT SUMMARY CARD ====================
        const paymentCardY = 290;
        
        // Payment Summary Box with gradient effect (using filled rect)
        doc.roundedRect(50, paymentCardY, 495, 50, 8)
           .fill(colors.bgCard)
           .stroke(colors.primary);
        
        // Left accent bar
        doc.rect(50, paymentCardY, 6, 50).fill(colors.primary);
        
        doc.fillColor(colors.primary)
           .font('Helvetica-Bold')
           .fontSize(10)
           .text('PAYMENT SUMMARY', 70, paymentCardY + 10);
        
        doc.fontSize(9).fillColor(colors.textDark);
        
        // Total Amount
        doc.font('Helvetica').fillColor(colors.textMedium);
        doc.text('Total Amount:', 70, paymentCardY + 30);
        doc.font('Helvetica-Bold').fillColor(colors.textDark);
        doc.text(formatCurrency(bill.totalAmount), 170, paymentCardY + 30);
        
        // Paid Amount
        doc.font('Helvetica').fillColor(colors.textMedium);
        doc.text('Paid Amount:', 300, paymentCardY + 30);
        doc.font('Helvetica-Bold').fillColor(colors.success);
        doc.text(formatCurrency(bill.paidAmount || 0), 400, paymentCardY + 30);
        
        // Due Amount
        const dueAmount = (bill.totalAmount - (bill.paidAmount || 0));
        doc.font('Helvetica').fillColor(colors.textMedium);
        doc.text('Due Amount:', 70, paymentCardY + 42);
        doc.font('Helvetica-Bold').fillColor(dueAmount > 0 ? colors.danger : colors.success);
        doc.text(formatCurrency(dueAmount), 170, paymentCardY + 42);
        
        // Status Badge
        doc.font('Helvetica').fillColor(colors.textMedium);
        doc.text('Status:', 300, paymentCardY + 42);
        
        let statusColor = colors.warning;
        let statusText = bill.status || 'Pending';
        let bgColor = '#FEF3C7';
        if (bill.paidAmount >= bill.totalAmount) {
            statusColor = colors.success;
            statusText = 'PAID';
            bgColor = '#D1FAE5';
        } else if (bill.paidAmount > 0) {
            statusColor = colors.warning;
            statusText = 'PARTIALLY PAID';
            bgColor = '#FEF3C7';
        } else {
            statusColor = colors.danger;
            statusText = 'PENDING';
            bgColor = '#FEE2E2';
        }
        
        // Status badge
        const badgeWidth = 90;
        const badgeHeight = 18;
        doc.roundedRect(400, paymentCardY + 32, badgeWidth, badgeHeight, 4)
           .fill(bgColor);
        doc.fillColor(statusColor)
           .font('Helvetica-Bold')
           .text(statusText, 445 - (badgeWidth / 2), paymentCardY + 36, { align: 'center' });

        // ==================== TABLE ====================
        const tableTop = 365;
        
        // Table Header
        doc.roundedRect(50, tableTop, 495, 30, 4)
           .fill(colors.primary);
        
        doc.fillColor('#fff')
           .font('Helvetica-Bold')
           .fontSize(9);

        doc.text('ITEM / SERVICE', 60, tableTop + 10);
        doc.text('GST RATE', 195, tableTop + 10);
        doc.text('QTY', 265, tableTop + 10);
        doc.text('RATE (₹)', 315, tableTop + 10);
        doc.text('AMOUNT (₹)', 380, tableTop + 10);
        doc.text('CGST (₹)', 450, tableTop + 10);
        doc.text('SGST (₹)', 505, tableTop + 10, { align: 'right' });

        let rowY = tableTop + 30;
        let serialNo = 1;
        let grandTotalBeforeGst = 0;
        let totalCgst = 0;
        let totalSgst = 0;

        // Handle services
        let servicesList = [];
        if (bill.services && bill.services.length > 0) {
            servicesList = bill.services;
        } else {
            servicesList = [{
                serviceName: bill.serviceName || 'Service',
                description: bill.description || '',
                quantity: 1,
                unitPrice: bill.totalAmount - (bill.gstAmount || 0),
                totalPrice: bill.totalAmount - (bill.gstAmount || 0),
                gstRate: 18,
                gstAmount: bill.gstAmount || 0
            }];
        }

        servicesList.forEach((service, index) => {
            const amount = service.totalPrice || service.unitPrice || 0;
            const gstAmount = service.gstAmount || (amount * (service.gstRate || 18) / 100) || 0;
            const cgst = gstAmount / 2;
            const sgst = gstAmount / 2;
            const rate = service.unitPrice || amount;
            const qty = service.quantity || 1;
            const gstRate = service.gstRate || 18;
            
            grandTotalBeforeGst += amount;
            totalCgst += cgst;
            totalSgst += sgst;

            const hasDesc = service.description && service.description.length > 0;
            const rowHeight = hasDesc ? 52 : 38;

            // Row background (alternating colors)
            if (index % 2 === 0) {
                doc.rect(50, rowY, 495, rowHeight).fill('#FFFFFF');
            } else {
                doc.rect(50, rowY, 495, rowHeight).fill(colors.bgLight);
            }
            doc.rect(50, rowY, 495, rowHeight).stroke(colors.border);

            doc.fillColor(colors.textDark)
               .font('Helvetica')
               .fontSize(9);
            
            // Service name with serial
            doc.text(`${serialNo}. ${service.serviceName}`, 60, rowY + 8, { width: 130 });
            
            // Description if exists
            if (hasDesc) {
                doc.fontSize(8)
                   .fillColor(colors.textLight)
                   .text(service.description, 60, rowY + 24, { width: 130 });
                doc.fontSize(9)
                   .fillColor(colors.textDark);
            }

            // Table data
            doc.text(`${gstRate}%`, 200, rowY + (hasDesc ? 12 : 8));
            doc.text(qty.toString(), 270, rowY + (hasDesc ? 12 : 8));
            doc.text(formatCurrency(rate), 320, rowY + (hasDesc ? 12 : 8));
            doc.text(formatCurrency(amount), 385, rowY + (hasDesc ? 12 : 8));
            doc.text(formatCurrency(cgst), 450, rowY + (hasDesc ? 12 : 8));
            doc.text(formatCurrency(sgst), 515, rowY + (hasDesc ? 12 : 8), { align: 'right' });

            rowY += rowHeight;
            serialNo++;
        });

        // ==================== SUMMARY SECTION ====================
        const summaryY = rowY + 20;
        
        // Summary Box with premium styling
        doc.roundedRect(330, summaryY, 215, 110, 8)
           .fill(colors.bgLight)
           .stroke(colors.primary);
        
        doc.fillColor(colors.primary)
           .font('Helvetica-Bold')
           .fontSize(10)
           .text('INVOICE SUMMARY', 345, summaryY + 12);

        doc.fontSize(9)
           .font('Helvetica');
        
        let sumY = summaryY + 32;
        
        doc.fillColor(colors.textMedium);
        doc.text('Subtotal:', 345, sumY);
        doc.fillColor(colors.textDark);
        doc.text(formatCurrency(grandTotalBeforeGst), 500, sumY, { align: 'right' });

        sumY += 20;
        doc.fillColor(colors.textMedium);
        doc.text('CGST (9%):', 345, sumY);
        doc.fillColor(colors.textDark);
        doc.text(formatCurrency(totalCgst), 500, sumY, { align: 'right' });

        sumY += 20;
        doc.fillColor(colors.textMedium);
        doc.text('SGST (9%):', 345, sumY);
        doc.fillColor(colors.textDark);
        doc.text(formatCurrency(totalSgst), 500, sumY, { align: 'right' });

        // Divider
        sumY += 20;
        doc.moveTo(345, sumY).lineTo(530, sumY).lineWidth(0.5).stroke(colors.border);
        sumY += 12;

        doc.font('Helvetica-Bold')
           .fontSize(11)
           .fillColor(colors.primary);
        doc.text('GRAND TOTAL', 345, sumY);
        doc.text(formatCurrency(bill.totalAmount), 500, sumY, { align: 'right' });

        // ==================== BANK DETAILS ====================
        const bankY = summaryY + 135;

        doc.roundedRect(50, bankY, 260, 85, 6)
           .fill(colors.bgLight)
           .stroke(colors.border);
        
        doc.fillColor(colors.primary)
           .font('Helvetica-Bold')
           .fontSize(9)
           .text('BANK DETAILS', 60, bankY + 10);
        
        doc.font('Helvetica')
           .fontSize(8)
           .fillColor(colors.textMedium);

        doc.text('Account Name:', 60, bankY + 30);
        doc.font('Helvetica-Bold').fillColor(colors.textDark);
        doc.text('VIRAL ADS MEDIA', 150, bankY + 30);
        
        doc.font('Helvetica').fillColor(colors.textMedium);
        doc.text('Account Number:', 60, bankY + 44);
        doc.font('Helvetica-Bold').fillColor(colors.textDark);
        doc.text('2402244856193850', 150, bankY + 44);
        
        doc.font('Helvetica').fillColor(colors.textMedium);
        doc.text('IFSC:', 60, bankY + 58);
        doc.font('Helvetica-Bold').fillColor(colors.textDark);
        doc.text('AUBL0002448', 150, bankY + 58);
        
        doc.font('Helvetica').fillColor(colors.textMedium);
        doc.text('Account Type:', 60, bankY + 72);
        doc.font('Helvetica-Bold').fillColor(colors.textDark);
        doc.text('Current', 150, bankY + 72);
        
        doc.font('Helvetica').fillColor(colors.textMedium);
        doc.text('Bank:', 60, bankY + 86);
        doc.font('Helvetica-Bold').fillColor(colors.textDark);
        doc.text('AU Small Finance Bank', 150, bankY + 86);

        // ==================== PAYMENT HISTORY (if any) ====================
        let paymentHistoryY = bankY + 105;
        
        if (bill.payments && bill.payments.length > 0) {
            doc.roundedRect(50, paymentHistoryY, 495, Math.min(70 + (bill.payments.length * 18), 120), 6)
               .fill(colors.bgLight)
               .stroke(colors.border);
            
            doc.fillColor(colors.primary)
               .font('Helvetica-Bold')
               .fontSize(9)
               .text('PAYMENT HISTORY', 60, paymentHistoryY + 10);
            
            doc.font('Helvetica')
               .fontSize(8)
               .fillColor(colors.textMedium);
            
            let payY = paymentHistoryY + 30;
            
            bill.payments.forEach((payment, idx) => {
                doc.text(`${idx + 1}. ${formatCurrency(payment.amount)} - ${payment.paymentMethod || 'N/A'} - ${new Date(payment.paymentDate).toLocaleDateString('en-IN')}`, 
                    60, payY);
                if (payment.remarks) {
                    doc.fontSize(7)
                       .fillColor(colors.textLight)
                       .text(`   ${payment.remarks}`, 60, payY + 10);
                    payY += 10;
                }
                payY += 14;
            });
            paymentHistoryY = payY + 20;
        }

        // ==================== FOOTER & SIGNATURE ====================
        const footerY = Math.max(720, paymentHistoryY + 40);

        // Signature section
        doc.fontSize(10)
           .font('Helvetica-Bold')
           .fillColor(colors.textDark)
           .text('Authorised Signatory', 50, footerY);
        
        doc.moveTo(50, footerY + 22).lineTo(160, footerY + 22).lineWidth(0.6).stroke(colors.border);
        doc.fontSize(8)
           .fillColor(colors.textLight)
           .text('(Signature)', 80, footerY + 24);

        // Thank you message
        doc.fontSize(10)
           .font('Helvetica')
           .fillColor(colors.primary)
           .text('Thank you for your business!', 250, footerY, { align: 'center', width: 250 });

        // ==================== FOOTER BAR ====================
        const footerBarY = footerY + 55;
        
        doc.rect(0, footerBarY, 612, 40).fill(colors.primary);
        
        doc.fillColor('#fff')
           .fontSize(8)
           .font('Helvetica')
           .text('For any enquiry, reach out via email at info@viraladsmedia.com, call on +91 93544 91934', 
                50, footerBarY + 12, { align: 'center', width: 512 });
        
        doc.fontSize(7)
           .fillColor('#BFDBFE')
           .text('Terms: Payment is due within 15 days of invoice date. Late payments may incur additional charges.', 
                50, footerBarY + 26, { align: 'center', width: 512 });

        doc.end();

    } catch (error) {
        console.error('PDF Generation Error:', error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Error generating PDF: ' + error.message });
        }
    }
};
// Edit bill (alias for update)
exports.editBill = async (req, res) => {
    return exports.updateBill(req, res);
};


// Add this function at the end of file
exports.forceDeleteBill = async (req, res) => {
    try {
        const { id } = req.params;
        console.log('Force deleting bill with payments:', id);

        const deletedBill = await Bill.findByIdAndDelete(id);

        if (!deletedBill) {
            return res.status(404).json({
                success: false,
                message: 'Bill not found'
            });
        }

        console.log('Force deleted bill:', deletedBill.billNumber, 'with', deletedBill.payments?.length, 'payments');

        return res.status(200).json({
            success: true,
            message: 'Bill and all associated payments deleted successfully',
            data: deletedBill
        });
    } catch (error) {
        console.error('Force delete error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};