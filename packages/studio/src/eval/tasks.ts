import type { LabeledTask } from './selection.js'

/**
 * The labeled task set for the reference "orders" recipe (COV_INF_006.3). Tasks are written the
 * way a user would type them into Claude — paraphrases, synonyms, and sloppy grammar — not as
 * restatements of the tool names, which would make the eval measure nothing.
 */
export const REFERENCE_TASKS: LabeledTask[] = [
  { task: 'show me the orders that came in this week', expect: 'list_orders' },
  { task: 'which purchases are still open?', expect: 'list_orders' },
  { task: 'find the orders that were refunded', expect: 'list_orders' },
  { task: 'how many sales are on the second page', expect: 'list_orders' },
  { task: 'pull up order 1042', expect: 'get_order' },
  { task: 'what is the current status of order number 1043', expect: 'get_order' },
  { task: 'open the record for a single order i already have the id for', expect: 'get_order' },
  { task: 'place a new order for two boxes of tea', expect: 'create_order' },
  { task: 'add an order for customer 88 in usd', expect: 'create_order' },
  { task: 'submit a fresh purchase with these items', expect: 'create_order' },
  { task: 'mark order 1042 as shipped and attach tracking TRK-99', expect: 'update_order' },
  { task: 'change order 1043 to delivered', expect: 'update_order' },
  { task: 'set the tracking number on an order', expect: 'update_order' },
  { task: 'give the shopper their money back for order 1030', expect: 'refund_order' },
  { task: 'issue a refund on order 1031 because it arrived damaged', expect: 'refund_order' },
  { task: 'reimburse the buyer for a bad order', expect: 'refund_order' },
  { task: 'the buyer changed their mind, call off order 1044', expect: 'cancel_order' },
  { task: 'cancel order 1044 before it ships', expect: 'cancel_order' },
  { task: 'stop an order that has not shipped yet', expect: 'cancel_order' },
  { task: 'list every customer account we have', expect: 'list_customers' },
  { task: 'who are our shoppers?', expect: 'list_customers' },
  { task: 'look up customer 88', expect: 'get_customer' },
  { task: 'show me the details and lifetime value for customer 91', expect: 'get_customer' },
  { task: 'what products do we sell?', expect: 'list_products' },
  { task: 'show the catalog with current stock levels', expect: 'list_products' },
  { task: 'where is the parcel for order 1042?', expect: 'list_shipments' },
  { task: 'show the delivery carrier and tracking for order 1043', expect: 'list_shipments' },
  { task: 'has the package for this order gone out yet', expect: 'list_shipments' },
]
