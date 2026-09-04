import { describe, it, expect } from "vitest";
import { parseFlipkartExport } from "../src/ingestion/parsers/flipkart";
import { parseMeeshoExport } from "../src/ingestion/parsers/meesho";
import { parseSnapdealExport } from "../src/ingestion/parsers/snapdeal";

// Fixtures below mirror the real column layout and quirks of the sample
// exports the mapping was built from (quoted dates with embedded commas,
// the "NA" tax placeholder, the apostrophe text-guard on numeric IDs, the
// Sub Order No line-index suffix, etc.) — not invented shapes.

const FLIPKART_CSV = `Ordered On,Shipment ID,ORDER ITEM ID,Order Id,HSN CODE,Order State,Order Type,FSN,SKU,Product,Invoice No.,CGST,IGST,SGST,Invoice Date (mm/dd/yy),Invoice Amount,Selling Price Per Item,Shipping and Handling Charges,Quantity,Price inc. FKMP Contribution & Subsidy,Buyer name,Ship to name,Address Line 1,Address Line 2,City,State,PIN Code,Dispatch After date,Dispatch by date,Form requirement,Tracking ID,Package Length (cm),Package Breadth (cm),Package Height (cm),Package Weight (kg),Ready to Make,With Attachment
"Aug 26, 2026",0b7bffa9-2130-4ccf-9e18-728e36bb5237,'438462135749739102,OD438462135749739100,6211,Ready to dispatch,NON_FBF,DREHZHPVMRRAZYMH,SVM-02-Purple night set Dress-XL,Vardhamiti Women Two Piece Dress Purple Ankle Length Dress XL SVM-02-Purple night set Dress,LWADHI7270000164,NA,5,NA,08/26/26,428,313,0,1,428,Richa Budholiya,Richa Budholiya,"Flat - 714, Swaraaj Heights, near 18 Latitude Mall, Punawale","Kate Wasti, Punawale, Pimpri-Chinchwad",Pune,Maharashtra,411033,"Aug 26, 2026 23:16:23","Aug 27, 2026 12:00:00",,FMPP4241805152,8,4,2,0.2,NO,NO
`;

const MEESHO_CSV = `"Reason for Credit Entry","Sub Order No","Catalog ID","Order Date","Order source","Customer State","Product Name","SKU","Size","Quantity","Supplier Listed Price (Incl. GST + Commission)","Supplier Discounted Price (Incl GST and Commision)","Packet Id"
"READY_TO_SHIP","324074730393034112_1","270176377","2026-08-26","","Karnataka","Trendy Stylish Women Rayon Graphic Print Nightsuit/Top and Bottom Set for Women Very Fashionable and Comfortable Under Rs. 449","JK-Blue","M","1","340.0","323.0",
`;

const SNAPDEAL_CSV = `REFERENCECODE,ORDERCODE,SUBORDERCODE,PRODUCTNAME,ORDERVERIFIEDDATE,ORDERCREATEDDATE,AWBNO,SHIPPINGPROVIDER,SHIPPINGCITY,SHIPPINGMETHOD,INVOICENUMBER,INVOICEDATE,IMEISERIAL,STATUS,MANIFESTBYDATE,SHIPPEDON,DELIVEREDON,RETURNINITIATEDON,RETURNDELIVEREDON,REVERSEAWBNO,REVERSECOURIERCODE,SKUCODE,PACKAGEID,PRODUCTCATEGORY,ATTRIBUTES,IMAGEURL,PDPURL,FREEBIES,TRACKINGURL,ITEMID,MANIFESTCODE,RMSINFOMAP,PROMISEDSHIPDATE,NONSERVICABLEFROM,HOLDDATE,HOLDREASON,MRP,EXPECTEDDELIVERYDATE,TAXPERCENTAGE,CREATED,ESDFORVENDOR
"SLP5096041940","65728105130","74125384041","KANJHUSH Rayon Printed Women Shirt with Shorts Nightsuit Set ( Yellow ) (Color: Yellow, Size: S)","17:45:09 26-08-2026","17:44:53 26-08-2026","7269623892344","DELHIVERY_ESSENTIAL","Gwalior","STD","S1CE83/26/168","09:59:06 27-08-2026","NA","Ready to be Picked up by Courier","17:44:53 27-08-2026","","","","","","","NT-64-S","542223107","Shiptogether-1 Men/Women fashion - SD+","Color - Yellow , Size - S","http://example.com/a.jpg","http://example.com/p","","https://www.delhivery.com/track/package/7269623892344","622668032","SM446882602","","17:44:53 27-08-2026","","","","2599","","","10:17:18 27-08-2026",""
`;

describe("Flipkart export parser", () => {
  const [order] = parseFlipkartExport(FLIPKART_CSV);

  it("maps the order id and strips the text-guard from the line item id", () => {
    expect(order.marketplaceOrderId).toBe("OD438462135749739100");
    expect(order.items[0].marketplaceLineItemId).toBe("438462135749739102");
  });

  it("maps 'Ready to dispatch' to READY_TO_DISPATCH", () => {
    expect(order.status).toBe("READY_TO_DISPATCH");
  });

  it("coerces the NA tax placeholders to null, keeps the real value", () => {
    expect(order.items[0].taxCgst).toBeNull();
    expect(order.items[0].taxIgst).toBe("5");
    expect(order.items[0].taxSgst).toBeNull();
  });

  it("captures the dispatch SLA window for Daily Dispatch", () => {
    expect(order.shipment?.dispatchWindowStart).toBeInstanceOf(Date);
    expect(order.shipment?.dispatchWindowEnd).toBeInstanceOf(Date);
    expect(order.shipment!.dispatchWindowEnd!.getTime()).toBeGreaterThan(order.shipment!.dispatchWindowStart!.getTime());
  });
});

describe("Meesho export parser", () => {
  const [order] = parseMeeshoExport(MEESHO_CSV);

  it("splits the Sub Order No into order id and line sequence", () => {
    expect(order.marketplaceOrderId).toBe("324074730393034112");
    expect(order.items[0].marketplaceLineItemId).toBe("1");
  });

  it("reads the mislabeled status column correctly", () => {
    expect(order.status).toBe("READY_TO_DISPATCH");
  });

  it("keeps size as its own field, not embedded in the SKU", () => {
    expect(order.items[0].marketplaceSku).toBe("JK-Blue");
    expect(order.items[0].variantSize).toBe("M");
  });

  it("has no AWB — Daily Dispatch needs a separate Meesho label export", () => {
    expect(order.shipment?.awbNumber ?? null).toBeNull();
  });
});

describe("Snapdeal export parser", () => {
  const [order] = parseSnapdealExport(SNAPDEAL_CSV);

  it("maps order/shipment identifiers", () => {
    expect(order.marketplaceOrderId).toBe("65728105130");
    expect(order.shipment?.awbNumber).toBe("7269623892344");
  });

  it("maps 'Ready to be Picked up by Courier' to READY_TO_DISPATCH", () => {
    expect(order.status).toBe("READY_TO_DISPATCH");
  });

  it("exposes MRP, not a real selling price, per the mapping note", () => {
    expect(order.items[0].mrp).toBe("2599");
  });
});
