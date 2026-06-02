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

    const lastBill = await Bill.findOne({
        billNumber: { $regex: `INV/${year}/${month}` }
    }).sort({ createdAt: -1 });

    let sequence = 1;
    if (lastBill) {
        const lastSequence = parseInt(lastBill.billNumber.split('/').pop());
        sequence = lastSequence + 1;
    }

    const billNumber = `INV/${year}/${month}/${String(sequence).padStart(4, '0')}`;

    const exists = await Bill.findOne({ billNumber });
    if (exists && retryCount < 5) {
        return generateBillNumber(retryCount + 1);
    }

    return billNumber;
};

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
            clientName,
            leadOwner,
            serviceName,
            description,
            duration, 
            totalAmount,
            dueDate,
            gstAmount,
            gstPercentage,
            taxType,
            notes,
            initialPayment,
            paymentMethod,
            transactionId,
            paymentRemarks,
            services
        } = req.body;

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

        const calculatedGstAmount = parseFloat(gstAmount) || parsedTotalGst;
        const currentTaxType = taxType || 'CGST+SGST';
        const isIGST = (currentTaxType === 'IGST');

        let cgstAmount = 0;
        let sgstAmount = 0;
        let igstAmount = 0;

        if (isIGST) {
            igstAmount = calculatedGstAmount;
        } else {
            cgstAmount = calculatedGstAmount / 2;
            sgstAmount = calculatedGstAmount / 2;
        }

        const newBill = new Bill({
            billNumber,
            clientId,
            clientName: clientName || client?.name || '',
            leadOwner: leadOwner || '',
            serviceName: displayServiceName,
            description: description || '',
            duration: duration || '', 
            totalAmount: parsedTotalAmount,
            dueDate: new Date(dueDate),
            gstAmount: calculatedGstAmount,
            gstPercentage: parseFloat(gstPercentage) || 0,
            cgst: cgstAmount,
            sgst: sgstAmount,
            igst: igstAmount,
            taxType: currentTaxType,
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
                    duration: service.duration || '',
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
                    // ✅ FIRST TIME - Create new service bill (WITHOUT GST)
                    const serviceTotalWithoutGST = parsedTotalAmount - calculatedGstAmount;
                    
                    serviceBill = new ServiceBill({
                        clientId: clientId,
                        serviceName: serviceName,
                        totalAmount: serviceTotalWithoutGST,
                        paidAmount: parsedInitialPayment,
                        dueAmount: serviceTotalWithoutGST - parsedInitialPayment,
                        status: parsedInitialPayment >= parsedTotalAmount ? 'Paid' : (parsedInitialPayment > 0 ? 'Partially Paid' : 'Pending'),
                        bills: [{ billId: newBill._id, billNumber: billNumber, amount: parsedTotalAmount, paymentReceived: parsedInitialPayment, date: new Date() }]
                    });
                } else {
                    const isInstallmentBill = parsedInitialPayment === parsedTotalAmount && 
                                               parsedTotalAmount <= serviceBill.dueAmount;
                    
                    console.log(`📊 Existing ServiceBill: Total=${serviceBill.totalAmount}, Paid=${serviceBill.paidAmount}, Due=${serviceBill.dueAmount}`);
                    console.log(`📊 New bill: Amount=${parsedTotalAmount}, Paid=${parsedInitialPayment}, isInstallment=${isInstallmentBill}`);
                    
                    if (isInstallmentBill) {
                        console.log(`📌 INSTALLMENT payment detected for ${serviceName}: +₹${parsedInitialPayment}`);
                        serviceBill.paidAmount += parsedInitialPayment;
                    } else {
                        console.log(`📌 REGULAR bill detected for ${serviceName}: +₹${parsedTotalAmount} total, +₹${parsedInitialPayment} paid`);
                       // serviceBill.totalAmount += parsedTotalAmount;
                        serviceBill.paidAmount += parsedInitialPayment;
                    }
                    
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
                        remarks: paymentRemarks || (isInstallmentBill ? `Installment payment of ₹${parsedInitialPayment.toLocaleString('en-IN')}` : 'Payment'),
                        receivedBy: req.user?.username || 'System',
                        billNumber: billNumber,
                        paymentDate: new Date()
                    });
                }

                await serviceBill.save();
                console.log(`✅ ServiceBill saved: Total=${serviceBill.totalAmount}, Paid=${serviceBill.paidAmount}, Due=${serviceBill.dueAmount}`);
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

                    const isInstallmentBill = proportionalPayment === serviceTotal && 
                                               serviceTotal <= (serviceBill?.dueAmount || serviceTotal);

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
                        
                        if (isInstallmentBill) {
                            console.log(`      📌 INSTALLMENT payment detected: +₹${proportionalPayment}`);
                            serviceBill.paidAmount += proportionalPayment;
                        } else {
                            console.log(`      📌 REGULAR bill detected: +₹${serviceTotal} total, +₹${proportionalPayment} paid`);
                            serviceBill.paidAmount += proportionalPayment;
                        }
                        
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
                            remarks: paymentRemarks || (isInstallmentBill ? `Installment payment` : 'Initial payment'),
                            receivedBy: req.user?.username || 'System',
                            billNumber: billNumber,
                            paymentDate: new Date()
                        });
                    }

                    await serviceBill.save();
                    console.log(`   ✅ ServiceBill saved for: ${service.serviceName} - Total: ${serviceBill.totalAmount}, Paid: ${serviceBill.paidAmount}, Due: ${serviceBill.dueAmount}`);
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
        bill.dueAmount = bill.totalAmount - bill.paidAmount;

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

exports.getClientBillingSummary = async (req, res) => {
    try {
        const { clientId } = req.params;

        if (!clientId || clientId === 'undefined' || clientId === 'null') {
            return res.status(400).json({
                success: false,
                message: 'Valid client ID is required'
            });
        }

        const bills = await Bill.find({ clientId: clientId }).sort({ billDate: -1 });

        const summary = {
            totalBilled: 0,
            totalPaid: 0,
            totalDue: 0,
            billsCount: bills.length,
            overdueBills: 0,
            bills: bills.map(bill => ({
                _id: bill._id,
                billNumber: bill.billNumber,
                clientName: bill.clientName || '',
                leadOwner: bill.leadOwner || '',
                totalAmount: bill.totalAmount,
                paidAmount: bill.paidAmount,
                dueAmount: bill.dueAmount,
                status: bill.status,
                dueDate: bill.dueDate,
                billDate: bill.billDate,
                duration: bill.duration || '',
                gstAmount: bill.gstAmount || 0,
                gstPercentage: bill.gstPercentage || 0,
                cgst: bill.cgst || 0,
                sgst: bill.sgst || 0,
                igst: bill.igst || 0,
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
    // Keep your existing downloadBill function
};

exports.editBill = async (req, res) => {
    return exports.updateBill(req, res);
};

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